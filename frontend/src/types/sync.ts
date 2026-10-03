/**
 * 荫房平板离线同步（SyncBatch / RoomSyncEntry）数据模型
 * 荫房无网络：值守在平板上离线记录入房 / 出房与温湿度，回工作室后按批次合并进档案。
 *
 * 合并铁律：
 * - 只写荫房记录（Room），不回写道次（Coat）；平板冻结的道次快照仅用于留底比对；
 * - 荫房记录只认值守填的那份：温湿度与出入房时间原样入库，判定按档案统一规则复判，
 *   值守在平板上的原始判定保留在 tabletVerdict 中留底；
 * - 编号对不上的条次挂「待认领」，不阻断同批其余条次；
 * - 合并为单事务：中途失败整批回滚，工序台账照旧；已合并条次按 clientId 幂等去重。
 */
import type { CoatState, PaintType } from './coat';

/** 批次状态：离线编辑中 / 已合并入档案 / 合并中途失败（仅平板侧留底，档案零变化） */
export type SyncBatchStatus = 'open' | 'merged' | 'failed';

/**
 * 条次状态：
 * - pending：尚未合并（离线编辑中 / 等待下次合并）
 * - merged：已合并入档案
 * - duplicate：再送时发现档案中已有同一 clientId 的荫房记录，跳过（不多出记录）
 * - unclaimed：编号对不上，挂待认领，不挡其他条次
 */
export type SyncEntryStatus = 'pending' | 'merged' | 'duplicate' | 'unclaimed';

/** 平板冻结的道次快照：同步前的道次样貌，只留底比对，绝不回写档案 */
export interface CoatSnapshot {
  coatId: string;
  seq: number;
  paintType: PaintType;
  colorName: string;
  coatDate: string;
  state: CoatState;
  needRecheck: boolean;
}

/** 平板离线记录的单条入出房 + 温湿度（荫房记录只认值守填的这份） */
export interface RoomSyncEntry {
  /** 平板生成的条次 id（批次内唯一） */
  entryId: string;
  /**
   * 全局幂等键：合并成功后以 sourceClientId 落库到 Room。
   * 同一条次再送一次时据此判重，不多出记录。
   */
  clientId: string;
  /** 值守填写的关联胎体：可能是档案 bodyId，也可能是手抄编号（匹配不上即待认领） */
  bodyRef: string;
  /** 记录日期 yyyy-MM-dd */
  date: string;
  tempC: number;
  humidityPct: number;
  /** 入房时间 HH:mm */
  inAt: string;
  /** 出房时间 HH:mm */
  outAt: string;
  /** 值守在平板上选择的原始判定，留底；档案侧以统一规则复判为准 */
  tabletVerdict: 'suitable' | 'dry' | 'wet';
  /** 条次状态：未合并 / 已合并 / 重复跳过 / 待认领 */
  status: SyncEntryStatus;
  /** 合并后回写：档案中的 Room.id（认领后补合并时使用） */
  roomId: string | null;
  /** 认领后解析出的档案 bodyId */
  resolvedBodyId: string | null;
  /** 状态备注，如待认领原因、重复跳过提示 */
  note: string;
}

/** 荫房离线批次：一次值守带回的全部记录，平板与档案两侧各自留底 */
export interface SyncBatch {
  id: string;
  /** 批次业务编号，如 SYNC-261003-01 */
  code: string;
  /** 荫房值守人（荫房记录只认该值守填的这份） */
  watcherName: string;
  /** 平板创建批次的时间 */
  dispatchedAt: number;
  /** 最近一次合并尝试时间（成功或失败） */
  mergedAt: number | null;
  status: SyncBatchStatus;
  entries: RoomSyncEntry[];
  /** 同步前冻结的道次快照，按胎体分组，仅留底比对 */
  coatSnapshots: Array<{ bodyId: string; bodyCode: string; coats: CoatSnapshot[] }>;
  /** 已合并条次数 */
  mergedCount: number;
  /** 待认领条次数 */
  unclaimedCount: number;
  /** 重复跳过条次数 */
  duplicateCount: number;
  /** 失败批次的错误信息（仅平板侧留底） */
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建批次时的输入 */
export interface SyncBatchInput {
  watcherName: string;
  entries: Array<{
    bodyRef: string;
    date: string;
    tempC: number;
    humidityPct: number;
    inAt: string;
    outAt: string;
    tabletVerdict: RoomSyncEntry['tabletVerdict'];
  }>;
}

export const SYNC_BATCH_STATUS_LABEL: Record<SyncBatchStatus, string> = {
  open: '离线编辑中',
  merged: '已合并',
  failed: '合并失败',
};

export const SYNC_BATCH_STATUS_COLOR: Record<SyncBatchStatus, string> = {
  open: '#c9963c',
  merged: '#2f6f4f',
  failed: '#b03a2e',
};

export const SYNC_ENTRY_STATUS_LABEL: Record<SyncEntryStatus, string> = {
  pending: '待合并',
  merged: '已合并',
  duplicate: '重复跳过',
  unclaimed: '待认领',
};

export const SYNC_ENTRY_STATUS_COLOR: Record<SyncEntryStatus, string> = {
  pending: '#8c8c8c',
  merged: '#2f6f4f',
  duplicate: '#3a6ea5',
  unclaimed: '#b03a2e',
};

export const SYNC_BATCH_STATUS_OPTIONS: ReadonlyArray<{ value: SyncBatchStatus; label: string }> = [
  { value: 'open', label: '离线编辑中' },
  { value: 'merged', label: '已合并' },
  { value: 'failed', label: '合并失败' },
];
