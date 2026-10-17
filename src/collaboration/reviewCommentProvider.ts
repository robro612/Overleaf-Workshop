/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { CommentThreadMessageSchema, CommentThreadSchema, DocumentRangesSchema } from '../api/extendedBase';
import { DocumentEntity, VirtualFileSystem } from '../core/remoteFileSystemProvider';

const CONTROLLER_ID = `${ROOT_NAME}-review`;

/**
 * A quoted range following Overleaf's comment op format: `p` for position, `c` for quoted text.
 */
interface QuotedRange {
    p: number,
    c: string,
}

interface ReviewThread {
    id: string,
    docId?: string,
    remote?: QuotedRange, // offsets in the document's `remoteCache`
    view?: QuotedRange, // offsets in the opened `vscode.TextDocument`
    data: CommentThreadSchema,
    widget?: vscode.CommentThread,
}

/**
 * Reference: https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs
 */
function applyInsert(range: QuotedRange, p: number, text: string): QuotedRange {
    if (p <= range.p) {
        return {p: range.p + text.length, c: range.c};
    } else if (p < range.p + range.c.length) {
        const offset = p - range.p;
        return {p: range.p, c: range.c.slice(0, offset) + text + range.c.slice(offset)};
    }
    return range;
}

function applyDelete(range: QuotedRange, p: number, length: number): QuotedRange {
    const [opEnd, rangeEnd] = [p + length, range.p + range.c.length];
    if (length===0 || p >= rangeEnd) {
        return range;
    } else if (opEnd <= range.p) {
        return {p: range.p - length, c: range.c};
    } else {
        const [overlapStart, overlapEnd] = [Math.max(p, range.p), Math.min(opEnd, rangeEnd)];
        return {
            p: Math.min(p, range.p),
            c: range.c.slice(0, overlapStart - range.p) + range.c.slice(overlapEnd - range.p),
        };
    }
}

export function applyOps(range: QuotedRange, ops: NonNullable<UpdateSchema['op']>): QuotedRange {
    for (const op of ops) {
        if (op.i) { range = applyInsert(range, op.p, op.i); }
        else if (op.d) { range = applyDelete(range, op.p, op.d.length); }
    }
    return range;
}

export function applyContentChanges(range: QuotedRange, changes: readonly vscode.TextDocumentContentChangeEvent[]): QuotedRange {
    // changes are non-overlapping and relative to the old text, apply from the back
    const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const change of sorted) {
        range = applyDelete(range, change.rangeOffset, change.rangeLength);
        range = applyInsert(range, change.rangeOffset, change.text);
    }
    return range;
}

/**
 * Find the quoted text in `text`, preferring the occurrence nearest to the expected position.
 */
export function locate(text: string, range: QuotedRange): QuotedRange {
    if (text.slice(range.p, range.p + range.c.length)===range.c) {
        return range;
    }
    let best = -1;
    if (range.c.length) {
        for (let idx = text.indexOf(range.c); idx !== -1; idx = text.indexOf(range.c, idx + 1)) {
            if (best===-1 || Math.abs(idx - range.p) < Math.abs(best - range.p)) { best = idx; }
        }
    }
    return best===-1 ? {p: Math.min(range.p, text.length), c: range.c} : {p: best, c: range.c};
}

// Reference: https://github.com/overleaf/overleaf/blob/main/libraries/ranges-tracker/index.cjs (generateId)
function generateThreadId() {
    const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    return timestamp + randomBytes(8).toString('hex');
}

function abbreviate(text: string, maxLength: number = 40) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= maxLength ? oneLine : oneLine.slice(0, maxLength - 1) + '…';
}

const AVATAR_COLORS = ['#e8590c', '#2f9e44', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#f08c00', '#5f3dc4'];

/** An initials avatar with a stable color per user, since Overleaf has no profile pictures */
function avatarUri(userId: string, name: string) {
    const hash = [...userId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0);
    const color = AVATAR_COLORS[hash % AVATAR_COLORS.length];
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0].toUpperCase()).join('')
        .replace(/[<>&"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="${color}"/>`
        + `<text x="16" y="21" font-family="sans-serif" font-size="13" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

class ReviewComment implements vscode.Comment {
    body: string | vscode.MarkdownString;
    mode: vscode.CommentMode;
    author: vscode.CommentAuthorInformation;
    contextValue: string;
    timestamp: Date;
    label?: string;

    constructor(
        readonly threadId: string,
        readonly message: CommentThreadMessageSchema,
        isOwn: boolean,
        isFirst: boolean,
        isEditing: boolean,
    ) {
        this.body = message.content;
        this.mode = isEditing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
        const name = [message.user?.first_name, message.user?.last_name].filter(Boolean).join(' ');
        const displayName = name || message.user?.email || vscode.l10n.t('Unknown User');
        this.author = {name: displayName, iconPath: avatarUri(message.user_id || displayName, displayName)};
        // the first message stands for the thread; it is removed by deleting the thread
        this.contextValue = isOwn ? (isFirst ? 'own-first' : 'own') : 'other';
        this.timestamp = new Date(message.timestamp);
        this.label = message.edited_at ? vscode.l10n.t('(edited)') : undefined;
    }
}

export class ReviewCommentProvider extends vscode.Disposable {
    private readonly controller: vscode.CommentController;
    private readonly threads: {[threadId:string]: ReviewThread} = {};
    /** documents whose comment ranges came from `joinDoc`, which supersede the REST snapshot */
    private readonly joinedDocs = new Set<string>();
    private readonly editingMessages = new Set<string>();
    private refreshTimer?: NodeJS.Timeout;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly socket: SocketIOAPI,
    ) {
        super(() => {
            clearTimeout(this.refreshTimer);
            this.controller.dispose();
        });

        this.controller = vscode.comments.createCommentController(CONTROLLER_ID, vscode.l10n.t('Overleaf Comments'));
        this.controller.options = {
            prompt: vscode.l10n.t('Add a comment'),
            placeHolder: vscode.l10n.t('Add your comment here'),
        };
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async (document) => {
                if (document.uri.scheme!==ROOT_NAME || this.vfs.isInvisibleMode) { return []; }
                if (await this.resolveDocId(document.uri)===undefined) { return []; }
                return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
            },
        };

        this.registerSocketHandlers();
        this.loadThreads();
    }

    private async resolveDocId(uri: vscode.Uri) {
        try {
            const {fileType, fileId} = await this.vfs._resolveUri(uri);
            return fileType==='doc' ? fileId : undefined;
        } catch {
            return undefined;
        }
    }

    private resolveDoc(docId: string) {
        try {
            const res = this.vfs._resolveById(docId);
            if (res?.fileType!=='doc') { return undefined; }
            const uri = this.vfs.pathToUri(res.path);
            const document = vscode.workspace.textDocuments.find(d => d.uri.toString()===uri.toString());
            return {uri, document, entity: res.fileEntity as DocumentEntity};
        } catch {
            return undefined;
        }
    }

    private getThread(threadId: string) {
        if (this.threads[threadId]===undefined) {
            this.threads[threadId] = {id: threadId, data: {messages: []}};
        }
        return this.threads[threadId];
    }

    private threadsInDoc(docId: string) {
        return Object.values(this.threads).filter(thread => thread.docId===docId);
    }

    /** Synchronously find the commented document at `uri`, so content changes are handled in order */
    private commentedDocId(uri: vscode.Uri) {
        if (uri.scheme!==ROOT_NAME) { return undefined; }
        const docIds = new Set(Object.values(this.threads).map(thread => thread.docId));
        for (const docId of docIds) {
            if (docId && this.resolveDoc(docId)?.uri.toString()===uri.toString()) { return docId; }
        }
        return undefined;
    }

    private async loadThreads(threadsOnly: boolean = false) {
        const res = await this.vfs.getAllCommentThreads();
        if (res===undefined) { return; }

        for (const [threadId, data] of Object.entries(res.threads)) {
            const thread = this.getThread(threadId);
            // keep messages that arrived via socket while loading
            const known = new Set(data.messages.map(m => m.id));
            const extra = thread.data.messages.filter(m => !known.has(m.id));
            thread.data = {...data, messages: [...data.messages, ...extra]};
        }

        if (!threadsOnly) {
            for (const [docId, ranges] of Object.entries(res.ranges)) {
                if (this.joinedDocs.has(docId)) { continue; }
                const remoteCache = this.resolveDoc(docId)?.entity.remoteCache;
                for (const comment of ranges.comments || []) {
                    const thread = this.getThread(comment.op.t);
                    thread.docId = docId;
                    thread.remote = {p: comment.op.p, c: comment.op.c};
                    if (remoteCache!==undefined) { thread.remote = locate(remoteCache, thread.remote); }
                }
            }
        }

        Object.values(this.threads).forEach(thread => this.render(thread));
    }

    /** Fetch threads again in case a socket event was missed */
    private scheduleRefresh() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.loadThreads(true), 3000);
    }

    private onRangesLoaded(docId: string, ranges: DocumentRangesSchema) {
        this.joinedDocs.add(docId);
        const doc = this.resolveDoc(docId);
        const comments = ranges.comments || [];
        const present = new Set(comments.map(c => c.op.t));
        // drop comments no longer present in the document
        for (const thread of this.threadsInDoc(docId)) {
            if (!present.has(thread.id)) {
                thread.remote = thread.view = undefined;
                this.render(thread);
            }
        }
        for (const comment of comments) {
            const thread = this.getThread(comment.op.t);
            thread.docId = docId;
            thread.remote = {p: comment.op.p, c: comment.op.c};
            // the editor may still hold the old content; it is synced again on reload
            thread.view = doc?.document && locate(doc.document.getText(), thread.remote);
            this.render(thread);
        }
    }

    private onUpdateApplied(docId: string, ops: NonNullable<UpdateSchema['op']>) {
        const doc = this.resolveDoc(docId);
        for (const thread of this.threadsInDoc(docId)) {
            if (thread.remote) { thread.remote = applyOps(thread.remote, ops); }
        }
        // the editor content follows via file change notification, except for new comments
        for (const op of ops) {
            if (op.c!==undefined && op.t!==undefined) {
                const thread = this.getThread(op.t);
                thread.docId = docId;
                thread.remote = {p: op.p, c: op.c};
                thread.view = doc?.document && locate(doc.document.getText(), thread.remote);
                this.render(thread);
            }
        }
    }

    private onDocumentChanged(e: vscode.TextDocumentChangeEvent) {
        if (e.contentChanges.length===0) { return; }
        const docId = this.commentedDocId(e.document.uri);
        if (docId===undefined) { return; }
        const threads = this.threadsInDoc(docId).filter(thread => thread.remote);
        if (threads.length===0) { return; }

        const remoteCache = this.resolveDoc(docId)?.entity.remoteCache;
        const text = e.document.getText();
        const synced = !e.document.isDirty && text===remoteCache;
        for (const thread of threads) {
            if (synced || thread.view===undefined) {
                thread.view = locate(text, thread.remote!);
            } else {
                thread.view = applyContentChanges(thread.view, e.contentChanges);
            }
            this.render(thread);
        }
    }

    private onDocumentOpened(document: vscode.TextDocument) {
        const docId = this.commentedDocId(document.uri);
        if (docId===undefined) { return; }
        const text = document.getText();
        for (const thread of this.threadsInDoc(docId)) {
            if (thread.remote===undefined) { continue; }
            thread.view = locate(text, thread.view ?? thread.remote);
            this.render(thread);
        }
    }

    private render(thread: ReviewThread, expand: boolean = false) {
        const doc = thread.docId && thread.remote ? this.resolveDoc(thread.docId) : undefined;
        if (doc===undefined || thread.remote===undefined) {
            thread.widget?.dispose();
            thread.widget = undefined;
            return;
        }
        // file renamed or moved
        if (thread.widget && thread.widget.uri.toString()!==doc.uri.toString()) {
            thread.widget.dispose();
            thread.widget = undefined;
        }

        let range = thread.widget?.range;
        if (doc.document) {
            thread.view = thread.view ?? locate(doc.document.getText(), thread.remote);
            range = new vscode.Range(
                doc.document.positionAt(thread.view.p),
                doc.document.positionAt(thread.view.p + thread.view.c.length),
            );
        }
        // positions are unknown until the document is opened
        if (range===undefined) { return; }

        const {data} = thread;
        const comments = data.messages.map((message, index) => new ReviewComment(
            thread.id, message, message.user_id===this.vfs._userId, index===0, this.editingMessages.has(message.id),
        ));
        if (thread.widget===undefined) {
            thread.widget = this.controller.createCommentThread(doc.uri, range, comments);
            thread.widget.collapsibleState = expand ?
                vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
        } else {
            if (!thread.widget.range?.isEqual(range)) { thread.widget.range = range; }
            thread.widget.comments = comments;
        }

        const quoted = abbreviate(thread.view?.c ?? thread.remote.c);
        if (data.resolved) {
            const user = data.resolved_by_user;
            const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email;
            thread.widget.label = name ?
                vscode.l10n.t('"{quoted}" · resolved by {name}', {quoted, name}) :
                vscode.l10n.t('"{quoted}" · resolved', {quoted});
        } else {
            thread.widget.label = `"${quoted}"`;
        }
        thread.widget.state = data.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        thread.widget.contextValue = data.resolved ? 'resolved' : 'unresolved';
        thread.widget.canReply = !data.resolved;
    }

    private registerSocketHandlers() {
        this.socket.updateEventHandlers({
            onCommentThreadMessageCreated: (threadId, message) => {
                const thread = this.getThread(threadId);
                if (!thread.data.messages.some(m => m.id===message.id)) {
                    thread.data.messages.push(message);
                    this.render(thread);
                }
            },
            onCommentThreadMessageEdited: (threadId, messageId, content) => {
                const message = this.threads[threadId]?.data.messages.find(m => m.id===messageId);
                if (message) {
                    message.content = content;
                    message.edited_at = Date.now();
                    this.render(this.threads[threadId]);
                }
            },
            onCommentThreadMessageDeleted: (threadId, messageId) => {
                const thread = this.threads[threadId];
                if (thread) {
                    thread.data.messages = thread.data.messages.filter(m => m.id!==messageId);
                    this.render(thread);
                }
            },
            onCommentThreadResolved: (threadId, user) => {
                const thread = this.threads[threadId];
                if (thread) {
                    thread.data = {...thread.data, resolved: true, resolved_by_user: user, resolved_at: new Date().toISOString()};
                    this.render(thread);
                }
            },
            onCommentThreadReopened: (threadId) => {
                const thread = this.threads[threadId];
                if (thread) {
                    thread.data = {...thread.data, resolved: false, resolved_by_user: undefined, resolved_at: undefined};
                    this.render(thread);
                }
            },
            onCommentThreadDeleted: (threadId) => {
                this.removeThread(threadId);
            },
        });
    }

    private removeThread(threadId: string) {
        this.threads[threadId]?.widget?.dispose();
        delete this.threads[threadId];
    }

    private findThread(widget: vscode.CommentThread) {
        return Object.values(this.threads).find(thread => thread.widget===widget);
    }

    private async createThread(reply: vscode.CommentReply) {
        const draft = reply.thread;
        const content = reply.text.trim();
        if (!content) { return; }
        if (this.vfs.isInvisibleMode) {
            vscode.window.showWarningMessage( vscode.l10n.t('Comments cannot be created in invisible mode.') );
            return;
        }

        const document = await vscode.workspace.openTextDocument(draft.uri);
        const docId = await this.resolveDocId(draft.uri);
        if (docId===undefined) { return; }

        // quote the selection if the draft was created from it, otherwise the whole line(s)
        let range = draft.range ?? new vscode.Range(0, 0, 0, 0);
        const selection = vscode.window.visibleTextEditors.find(e => e.document===document)?.selection;
        if (selection && !selection.isEmpty && selection.intersection(range)) {
            range = selection;
        } else if (range.isEmpty || (range.start.character===0 && range.end.character===0)) {
            range = new vscode.Range(range.start.line, 0, range.end.line, document.lineAt(range.end.line).text.length);
        }
        const p = document.offsetAt(range.start);
        const c = document.getText(range);
        if (!c.length) {
            vscode.window.showWarningMessage( vscode.l10n.t('Please select the text to comment on.') );
            return;
        }
        // comment ops are applied to the remote document, so local edits must be synced first
        if (document.isDirty) {
            await document.save();
        }

        const threadId = generateThreadId();
        try {
            if (document.getText()!==this.resolveDoc(docId)?.entity.remoteCache) {
                throw new Error( vscode.l10n.t('The document has changed, please try again.') );
            }
            if (!await this.vfs.createCommentThread(docId, threadId, p, c, content)) {
                throw new Error( vscode.l10n.t('Failed to create the comment.') );
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(err?.message || String(err));
            return;
        }

        draft.dispose();
        const thread = this.getThread(threadId);
        thread.docId = docId;
        thread.remote = {p, c};
        thread.view = {p, c};
        this.render(thread, true);
        if (thread.data.messages.length===0) { this.scheduleRefresh(); }
    }

    private async reply(reply: vscode.CommentReply) {
        const thread = this.findThread(reply.thread);
        const content = reply.text.trim();
        if (thread===undefined || !content) { return; }
        if (await this.vfs.postCommentThreadMessage(thread.id, content)) {
            this.scheduleRefresh();
        } else {
            vscode.window.showErrorMessage( vscode.l10n.t('Failed to post the reply.') );
        }
    }

    private async setResolved(widget: vscode.CommentThread, resolved: boolean) {
        const thread = this.findThread(widget);
        if (thread?.docId===undefined) { return; }
        const success = resolved ?
            await this.vfs.resolveCommentThread(thread.docId, thread.id) :
            await this.vfs.reopenResolvedCommentThread(thread.docId, thread.id);
        if (!success) {
            vscode.window.showErrorMessage( resolved ?
                vscode.l10n.t('Failed to resolve the comment.') : vscode.l10n.t('Failed to reopen the comment.') );
        } else if (thread.data.resolved!==resolved) {
            // in case the socket event is missed
            thread.data = resolved ?
                {...thread.data, resolved: true, resolved_at: new Date().toISOString()} :
                {...thread.data, resolved: false, resolved_by_user: undefined, resolved_at: undefined};
            this.render(thread);
        }
    }

    private async deleteThread(widget: vscode.CommentThread) {
        const thread = this.findThread(widget);
        if (thread?.docId===undefined) { return; }
        const confirm = vscode.l10n.t('Delete');
        const res = await vscode.window.showWarningMessage(
            vscode.l10n.t('Are you sure to delete this comment thread?'), {modal: true}, confirm);
        if (res!==confirm) { return; }
        if (await this.vfs.deleteCommentThread(thread.docId, thread.id)) {
            this.removeThread(thread.id);
        } else {
            vscode.window.showErrorMessage( vscode.l10n.t('Failed to delete the comment.') );
        }
    }

    private setEditing(comment: ReviewComment, editing: boolean) {
        editing ? this.editingMessages.add(comment.message.id) : this.editingMessages.delete(comment.message.id);
        const thread = this.threads[comment.threadId];
        thread && this.render(thread);
    }

    private async saveMessage(comment: ReviewComment) {
        const content = (typeof comment.body==='string' ? comment.body : comment.body.value).trim();
        this.setEditing(comment, false);
        if (!content || content===comment.message.content) { return; }
        if (await this.vfs.editCommentThreadMessage(comment.threadId, comment.message.id, content)) {
            comment.message.content = content;
            comment.message.edited_at = Date.now();
            const thread = this.threads[comment.threadId];
            thread && this.render(thread);
        } else {
            vscode.window.showErrorMessage( vscode.l10n.t('Failed to edit the comment.') );
        }
    }

    private async deleteMessage(comment: ReviewComment) {
        const confirm = vscode.l10n.t('Delete');
        const res = await vscode.window.showWarningMessage(
            vscode.l10n.t('Are you sure to delete this comment?'), {modal: true}, confirm);
        if (res!==confirm) { return; }
        if (await this.vfs.deleteCommentThreadMessage(comment.threadId, comment.message.id)) {
            const thread = this.threads[comment.threadId];
            if (thread) {
                thread.data.messages = thread.data.messages.filter(m => m.id!==comment.message.id);
                this.render(thread);
            }
        } else {
            vscode.window.showErrorMessage( vscode.l10n.t('Failed to delete the comment.') );
        }
    }

    get triggers() {
        return [
            this as vscode.Disposable,
            // keep comment positions in sync with remote and local edits
            EventBus.on('docRangesLoadedEvent', ({docId, ranges}) => this.onRangesLoaded(docId, ranges)),
            EventBus.on('docUpdateAppliedEvent', ({docId, ops}) => this.onUpdateApplied(docId, ops)),
            vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)),
            vscode.workspace.onDidOpenTextDocument(document => this.onDocumentOpened(document)),
            // register exposed commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.addComment`, () => {
                vscode.commands.executeCommand('workbench.action.addComment');
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.cancelThread`, (reply: vscode.CommentReply) => reply.thread.dispose()),
            // register comment widget commands
            vscode.commands.registerCommand(`${ROOT_NAME}.review.createThread`, (reply: vscode.CommentReply) => this.createThread(reply)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.reply`, (reply: vscode.CommentReply) => this.reply(reply)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.resolveThread`, (widget: vscode.CommentThread) => this.setResolved(widget, true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.reopenThread`, (widget: vscode.CommentThread) => this.setResolved(widget, false)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.deleteThread`, (widget: vscode.CommentThread) => this.deleteThread(widget)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.editMessage`, (comment: ReviewComment) => this.setEditing(comment, true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.cancelEditMessage`, (comment: ReviewComment) => this.setEditing(comment, false)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.saveMessage`, (comment: ReviewComment) => this.saveMessage(comment)),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.deleteMessage`, (comment: ReviewComment) => this.deleteMessage(comment)),
        ];
    }
}
