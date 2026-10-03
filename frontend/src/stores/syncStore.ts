/**
 * 荫房平板离线同步状态管理（Zustand）
 * 维护离线批次列表、合并入档案、待认领条次的认领与批次删除。
 * 合并 / 认领成功后联动刷新 rooms / coats，胎体卡片与越界统计随之更新。
 */
import { create } from 'zustand';
import { db } from '@/utils/db';
import type { SyncBatch, SyncBatchInput } from '@/types/sync';
import { applySync, claimEntry, createSyncBatch, removeSyncBatch } from '@/utils/sync';
import { useCoatStore } from './coatStore';
import { useRoomStore } from './roomStore';

export interface SyncFailure {
  message: string;
}

interface SyncStoreState {
  batches: SyncBatch[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadBatches: () => Promise<void>;
  createBatch: (input: SyncBatchInput) => Promise<SyncBatch>;
  /** 合并入档案（原子事务）；失败时抛出，由页面提示，批次留 failed 底 */
  mergeBatch: (batchId: string, simulateFailure?: boolean) => Promise<SyncBatch>;
  claimEntry: (batchId: string, entryId: string, bodyId: string) => Promise<void>;
  removeBatch: (batchId: string) => Promise<void>;
  pendingBatchCount: () => number;
  unclaimedEntryCount: () => number;
}

/** 合并后联动刷新档案侧 store（rooms + coats），卡片与统计即变 */
async function reloadArchiveStores(): Promise<void> {
  await Promise.all([useRoomStore.getState().loadRooms(), useCoatStore.getState().loadCoats()]);
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  batches: [],
  loading: false,
  ready: false,
  error: '',

  async loadBatches() {
    set({ loading: true });
    try {
      const batches = await db.syncBatches.orderBy('updatedAt').reverse().toArray();
      set({ batches, loading: false, ready: true, error: '' });
    } catch (error) {
      set({
        loading: false,
        ready: true,
        error: error instanceof Error ? error.message : '离线批次读取失败',
      });
    }
  },

  async createBatch(input) {
    const batch = await createSyncBatch(input);
    await get().loadBatches();
    return batch;
  },

  async mergeBatch(batchId, simulateFailure = false) {
    try {
      const { batch } = await applySync(batchId, simulateFailure);
      await Promise.all([get().loadBatches(), reloadArchiveStores()]);
      return batch;
    } catch (error) {
      // 中途失败只退平板这批：事务已整体回滚（工序台账零变化），批次留失败底，可再送一次
      const message = error instanceof Error ? error.message : '合并中途失败';
      try {
        const existing = await db.syncBatches.get(batchId);
        if (existing) {
          await db.syncBatches.put({ ...existing, status: 'failed', lastError: message, updatedAt: Date.now() });
        }
      } catch {
        /* 留底失败不掩盖原始错误 */
      }
      await get().loadBatches();
      throw new Error(message);
    }
  },

  async claimEntry(batchId, entryId, bodyId) {
    await claimEntry(batchId, entryId, bodyId);
    await get().loadBatches();
  },

  async removeBatch(batchId) {
    await removeSyncBatch(batchId);
    await get().loadBatches();
  },

  pendingBatchCount() {
    return get().batches.filter((batch) => batch.status !== 'merged').length;
  },

  unclaimedEntryCount() {
    return get().batches.reduce((sum, batch) => sum + batch.unclaimedCount, 0);
  },
}));
