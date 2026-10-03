/**
 * 荫房平板离线同步状态管理（Zustand）
 * 维护平板离线草稿（封班留底）、批次原档与待认领暂存；
 * 合并 / 认领的事务逻辑在 utils/sync.ts，store 只负责载入与调用。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { SyncDraft, SyncDraftDraft, SyncBatchRecord, SyncStagingRoom } from '@/types/sync';

interface SyncStoreState {
  drafts: SyncDraft[];
  batches: SyncBatchRecord[];
  staging: SyncStagingRoom[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadSync: () => Promise<void>;
  createDraft: (draft: SyncDraftDraft) => Promise<SyncDraft>;
  updateDraft: (id: string, patch: Partial<SyncDraft>) => Promise<void>;
  removeDraft: (id: string) => Promise<void>;
  /** 本班未封班草稿 */
  openDrafts: () => SyncDraft[];
  /** 批次合并 / 认领后刷新三张同步表 */
  refreshAfterMerge: () => Promise<void>;
}

function sortByDateDesc<T extends { date?: string; updatedAt: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.updatedAt - a.updatedAt;
  });
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  drafts: [],
  batches: [],
  staging: [],
  loading: false,
  ready: false,
  error: '',

  async loadSync() {
    set({ loading: true });
    try {
      const [drafts, batches, staging] = await Promise.all([
        db.syncDrafts.toArray(),
        db.syncBatches.orderBy('mergedAt').reverse().toArray(),
        db.syncStaging.toArray(),
      ]);
      set({
        drafts: sortByDateDesc(drafts),
        batches,
        staging: sortByDateDesc(staging),
        loading: false,
        ready: true,
        error: '',
      });
    } catch (error) {
      set({
        loading: false,
        ready: true,
        error: error instanceof Error ? error.message : '同步数据读取失败',
      });
    }
  },

  async createDraft(draft) {
    const now = Date.now();
    const row: SyncDraft = {
      ...draft,
      id: createId('rsync'),
      sealedBatchId: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.syncDrafts.put(row);
    await get().loadSync();
    return row;
  },

  async updateDraft(id, patch) {
    await db.syncDrafts.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadSync();
  },

  async removeDraft(id) {
    await db.syncDrafts.delete(id);
    await get().loadSync();
  },

  openDrafts() {
    return get()
      .drafts.filter((draft) => draft.sealedBatchId === null)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.updatedAt - a.updatedAt));
  },

  async refreshAfterMerge() {
    await get().loadSync();
  },
}));
