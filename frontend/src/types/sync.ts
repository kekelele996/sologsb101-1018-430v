/**
 * 荫房平板离线同步模型
 * - SyncDraft：平板在无网荫房录入的入出房 / 温湿度草稿，封班后留底
 * - SyncBatch：封班导出的批次文件，内含「同步前道次快照」，仅用于漂移比对、绝不回写
 * - SyncStagingRoom：编号对不上、挂待认领的荫房记录（不挡已并好的记录）
 * - SyncBatchRecord：档案侧合并成功后留存的批次原档（两边各自留底）
 */
import type { Coat, CoatState, PaintType } from './coat';
import type { RoomVerdict } from './room';

/** 批次文件标识，区别于整库备份（LacquerSnapshot.app） */
export const SYNC_BATCH_KIND = 'gblacquer-room-sync';

/** 同步前道次快照：只保留合并时判定「是否已被管理员推进」所需字段 */
export interface SyncCoatSnapshot {
  id: string;
  bodyId: string;
  seq: number;
  state: CoatState;
  paintType: PaintType;
  colorName: string;
}

/** 平板离线记的一条荫房记录（入房 / 出房 / 温湿度） */
export interface SyncRoomEntry {
  /** 平板端生成的稳定主键，合并后即作为档案 Room 主键（重送幂等、不多出记录） */
  clientId: string;
  /** 平板端关联的胎体 id；可能为空（只手填了编号） */
  bodyId: string;
  /** 值守填写的胎体编号，编号对不上时挂待认领 */
  bodyCode: string;
  /** 记录日期 yyyy-MM-dd */
  date: string;
  tempC: number;
  humidityPct: number;
  /** 入房时间 HH:mm */
  inAt: string;
  /** 出房时间 HH:mm */
  outAt: string;
  /** 值守人：荫房记录只认值守填的那份 */
  attendant: string;
}

/** 封班导出的同步批次文件 */
export interface SyncBatch {
  kind: typeof SYNC_BATCH_KIND;
  app: string;
  schemaVersion: number;
  /** 批次号，合并幂等键 */
  batchId: string;
  /** 产生批次的设备 id */
  deviceId: string;
  /** 本班值守人 */
  attendant: string;
  note: string;
  /** 封班时间 ISO 字符串 */
  sealedAt: string;
  /** 本班离线记录 */
  records: SyncRoomEntry[];
  /** 封班瞬间的道次快照（同步前的道次，仅比对、不回写） */
  coats: SyncCoatSnapshot[];
}

export interface SyncBatchSummary {
  /** 批次记录条数 */
  total: number;
  /** 编号匹配、本次新并入 */
  merged: number;
  /** 编号对不上、挂待认领 */
  unclaimed: number;
  /** 档案已存在、重复跳过 */
  duplicate: number;
  /** 越界（偏干 / 偏湿）记录条数 */
  overCount: number;
  /** 档案侧已被工序管理员推进、平板快照仍旧的道次数（不回退） */
  pushedCoats: number;
}

/** 档案侧留存的批次原档（syncBatches 表） */
export interface SyncBatchRecord extends SyncBatch {
  /** 主键，即 batchId */
  id: string;
  status: 'merged';
  mergedAt: number;
  summary: SyncBatchSummary;
}

/** 待认领状态：待认领 / 已认领并入 */
export type StagingStatus = 'unclaimed' | 'claimed';

/** 编号对不上的荫房记录（syncStaging 表） */
export interface SyncStagingRoom {
  /** 主键：批次号 + 客户端记录 id，避免跨批次碰撞 */
  id: string;
  clientId: string;
  batchId: string;
  /** 值守手填、档案里匹配不上的编号 */
  bodyCode: string;
  attendant: string;
  date: string;
  tempC: number;
  humidityPct: number;
  inAt: string;
  outAt: string;
  /** 合并时按统一区间重算的判定，认领后不必再算 */
  verdict: RoomVerdict;
  status: StagingStatus;
  /** 认领后并入的胎体 id */
  claimedBodyId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 平板端离线草稿（syncDrafts 表，封班后保留留底） */
export interface SyncDraft {
  /** 即该条荫房记录未来的 clientId */
  id: string;
  bodyId: string;
  bodyCode: string;
  attendant: string;
  date: string;
  tempC: number;
  humidityPct: number;
  inAt: string;
  outAt: string;
  /** 已封班的批次号；null 表示仍在本班录入中 */
  sealedBatchId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const STAGING_STATUS_LABEL: Record<StagingStatus, string> = {
  unclaimed: '待认领',
  claimed: '已认领',
};

export type SyncDraftDraft = Omit<SyncDraft, 'id' | 'sealedBatchId' | 'createdAt' | 'updatedAt'>;

export function createEmptySyncDraft(bodyId: string, bodyCode: string, attendant: string): SyncDraftDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    bodyCode,
    attendant,
    date: today,
    tempC: 24,
    humidityPct: 75,
    inAt: '09:00',
    outAt: '21:00',
  };
}

/** 从道次表截取同步前快照 */
export function toCoatSnapshot(coats: Coat[]): SyncCoatSnapshot[] {
  return coats.map((coat) => ({
    id: coat.id,
    bodyId: coat.bodyId,
    seq: coat.seq,
    state: coat.state,
    paintType: coat.paintType,
    colorName: coat.colorName,
  }));
}
