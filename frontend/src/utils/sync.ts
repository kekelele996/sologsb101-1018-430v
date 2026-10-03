/**
 * 荫房平板离线同步引擎
 *
 * 业务规则（与线下流程一一对应）：
 * 1. 平板无网，入房 / 出房 / 温湿度离线录入，封班导出批次，回工作室导入合并；
 * 2. 批次内嵌「同步前道次快照」，合并只做漂移比对，绝不把平板旧道次写回 coats，
 *    工序管理员已经推进过的道次不会被带回去；
 * 3. 荫房记录只认值守填的那份：温湿度 / 出入房时间原样落库，档案侧不覆盖；
 * 4. 荫干窗口一越界（偏干 / 偏湿），该胎体「没做完」的道次挂待复检（needRecheck），
 *    不动道次状态；胎体卡片与越界统计因派生自 rooms / coats 自动跟着变；
 * 5. 编号对不上的记录挂待认领（syncStaging），不挡其余能并上的记录；
 * 6. 两边各自留底：平板封班草稿保留，档案合并后留存批次原档（syncBatches）；
 * 7. 中途失败只回滚「平板这批」：整个合并在单个 Dexie 事务内，工序台账（bodies/coats 等）
 *    本来只读不写，失败即整批不落；同批次再送一次按 batchId 幂等，不多出记录。
 */
import { db, createId, DB_NAME, DB_SCHEMA_VERSION } from './db';
import { judgeVerdict } from './humidity';
import { toCoatSnapshot } from '@/types/sync';
import type { Body } from '@/types/body';
import type { Coat, CoatState } from '@/types/coat';
import type {
  SyncBatch,
  SyncBatchRecord,
  SyncBatchSummary,
  SyncCoatSnapshot,
  SyncDraft,
  SyncRoomEntry,
  SyncStagingRoom,
} from '@/types/sync';

const COAT_STATE_RANK: Record<CoatState, number> = { todo: 0, coated: 1, toPolish: 2, done: 3 };

/** 封班：把本班离线草稿打包成批次文件（同时回写草稿 sealedBatchId，完成平板侧留底） */
export async function sealSyncBatch(params: {
  deviceId: string;
  attendant: string;
  note: string;
  drafts: SyncDraft[];
  coats: Coat[];
}): Promise<SyncBatch> {
  const { deviceId, attendant, note, drafts, coats } = params;
  const unsealed = drafts.filter((draft) => draft.sealedBatchId === null);
  if (unsealed.length === 0) throw new Error('本班还没有待封班的荫房记录');

  const batchId = createId('batch');
  const sealedAt = new Date().toISOString();
  const records: SyncRoomEntry[] = unsealed.map((draft) => ({
    clientId: draft.id,
    bodyId: draft.bodyId,
    bodyCode: draft.bodyCode,
    date: draft.date,
    tempC: draft.tempC,
    humidityPct: draft.humidityPct,
    inAt: draft.inAt,
    outAt: draft.outAt,
    attendant: draft.attendant || attendant,
  }));

  const batch: SyncBatch = {
    kind: 'gblacquer-room-sync',
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    batchId,
    deviceId,
    attendant,
    note,
    sealedAt,
    records,
    coats: toCoatSnapshot(coats),
  };

  // 草稿不删（平板留底），只标批次号
  const now = Date.now();
  await db.syncDrafts.bulkPut(
    unsealed.map((draft) => ({ ...draft, sealedBatchId: batchId, updatedAt: now })),
  );
  return batch;
}

/** 校验批次文件，返回错误文案（空串表示通过） */
export function validateSyncBatch(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const batch = input as Partial<SyncBatch>;
  if (batch.kind !== 'gblacquer-room-sync') {
    return '不是荫房平板同步批次文件（kind 不匹配）';
  }
  if (batch.app !== DB_NAME) return `批次文件不属于本项目（app=${String(batch.app)}）`;
  if (typeof batch.batchId !== 'string' || batch.batchId.length === 0) return '批次缺少 batchId';
  if (!Array.isArray(batch.records)) return '批次缺少 records 集合';
  for (const entry of batch.records) {
    if (!entry || typeof entry.clientId !== 'string' || !entry.clientId) return '存在缺少 clientId 的记录';
    if (typeof entry.tempC !== 'number' || typeof entry.humidityPct !== 'number') {
      return `记录 ${entry.clientId ?? ''} 温湿度不合法`;
    }
    if (!entry.date || !entry.inAt || !entry.outAt) return `记录 ${entry.clientId ?? ''} 日期或出入房时间不完整`;
  }
  if (batch.coats !== undefined && !Array.isArray(batch.coats)) return '批次道次快照不合法';
  return '';
}

/** 一条记录的合并落点：并入 / 挂待认领 / 重复跳过 */
export type EntryOutcome =
  | { kind: 'merged'; entry: SyncRoomEntry; bodyId: string; verdict: SyncStagingRoom['verdict'] }
  | { kind: 'unclaimed'; entry: SyncRoomEntry; verdict: SyncStagingRoom['verdict']; stagingId: string }
  | { kind: 'duplicate'; entry: SyncRoomEntry };

export interface PreviewCoatDrift {
  coatId: string;
  bodyCode: string;
  seq: number;
  colorName: string;
  tabletState: CoatState;
  archiveState: CoatState;
}

export interface SyncPreview {
  batch: SyncBatch;
  alreadyMerged: boolean;
  outcomes: EntryOutcome[];
  bodyIdByCode: Map<string, string>;
  drifts: PreviewCoatDrift[];
  summary: SyncBatchSummary;
}

/** 按编号解析胎体：先 bodyId，再编号精确匹配 */
function resolveBody(entry: SyncRoomEntry, bodies: Body[]): Body | undefined {
  if (entry.bodyId) {
    const byId = bodies.find((body) => body.id === entry.bodyId);
    if (byId) return byId;
  }
  const code = entry.bodyCode.trim();
  if (code) {
    return bodies.find((body) => body.code.trim() === code);
  }
  return undefined;
}

/**
 * 干跑预览：不落库，算出每条记录落点、越界统计与道次漂移。
 * 纯函数，便于页面在「确认合并」前给值守确认。
 */
export function previewSyncBatch(batch: SyncBatch, bodies: Body[], coats: Coat[], existingRoomIds: Set<string>, alreadyMerged: boolean): SyncPreview {
  const outcomes: EntryOutcome[] = [];
  let merged = 0;
  let unclaimed = 0;
  let duplicate = 0;
  let overCount = 0;

  batch.records.forEach((entry) => {
    if (existingRoomIds.has(entry.clientId)) {
      outcomes.push({ kind: 'duplicate', entry });
      duplicate += 1;
      return;
    }
    const verdict = judgeVerdict(entry.tempC, entry.humidityPct);
    const body = resolveBody(entry, bodies);
    if (!body) {
      outcomes.push({
        kind: 'unclaimed',
        entry,
        verdict,
        stagingId: `${batch.batchId}:${entry.clientId}`,
      });
      unclaimed += 1;
      return;
    }
    if (verdict !== 'suitable') overCount += 1;
    outcomes.push({ kind: 'merged', entry, bodyId: body.id, verdict });
    merged += 1;
  });

  const drifts = diffCoatSnapshots(batch.coats ?? [], coats, bodies);
  const pushedCoats = drifts.length;

  return {
    batch,
    alreadyMerged,
    outcomes,
    bodyIdByCode: new Map(bodies.map((body) => [body.code.trim(), body.id])),
    drifts,
    summary: { total: batch.records.length, merged, unclaimed, duplicate, overCount, pushedCoats },
  };
}

/**
 * 漂移比对：平板快照在前、档案道次在后。
 * 档案状态比平板快照更靠后，说明工序管理员离线期间已推进 —— 只提示，绝不回退。
 */
export function diffCoatSnapshots(snapshots: SyncCoatSnapshot[], coats: Coat[], bodies: Body[]): PreviewCoatDrift[] {
  const archiveById = new Map(coats.map((coat) => [coat.id, coat]));
  const bodyCode = new Map(bodies.map((body) => [body.id, body.code]));
  const drifts: PreviewCoatDrift[] = [];
  snapshots.forEach((snapshot) => {
    const archive = archiveById.get(snapshot.id);
    if (!archive) return;
    if (COAT_STATE_RANK[archive.state] > COAT_STATE_RANK[snapshot.state]) {
      drifts.push({
        coatId: snapshot.id,
        bodyCode: bodyCode.get(snapshot.bodyId) ?? snapshot.bodyId,
        seq: snapshot.seq,
        colorName: snapshot.colorName,
        tabletState: snapshot.state,
        archiveState: archive.state,
      });
    }
  });
  return drifts;
}

export interface MergeResult {
  batchId: string;
  alreadyMerged: boolean;
  summary: SyncBatchSummary;
  record: SyncBatchRecord | null;
  /** 被挂待复检的胎体 id */
  recheckBodyIds: string[];
}

/**
 * 执行合并：单事务写 rooms / syncStaging / syncBatches，并把越界胎体的未完成道次挂待复检。
 * 事务内不写 bodies / coats 的结构字段，工序台账照旧；中途失败整批回滚。
 */
export async function mergeSyncBatch(batch: SyncBatch): Promise<MergeResult> {
  const already = await db.syncBatches.get(batch.batchId);
  if (already) {
    return { batchId: batch.batchId, alreadyMerged: true, summary: already.summary, record: already, recheckBodyIds: [] };
  }

  const [bodies, coats, rooms] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
  ]);
  const existingRoomIds = new Set(rooms.map((room) => room.id));
  const preview = previewSyncBatch(batch, bodies, coats, existingRoomIds, false);

  const mergedAt = Date.now();
  const roomRows = preview.outcomes
    .filter((item): item is Extract<EntryOutcome, { kind: 'merged' }> => item.kind === 'merged')
    .map((item) => ({
      id: item.entry.clientId,
      bodyId: item.bodyId,
      date: item.entry.date,
      tempC: item.entry.tempC,
      humidityPct: item.entry.humidityPct,
      inAt: item.entry.inAt,
      outAt: item.entry.outAt,
      verdict: item.verdict,
      attendant: item.entry.attendant,
      syncBatchId: batch.batchId,
      createdAt: mergedAt,
      updatedAt: mergedAt,
    }));

  const stagingRows: SyncStagingRoom[] = preview.outcomes
    .filter((item): item is Extract<EntryOutcome, { kind: 'unclaimed' }> => item.kind === 'unclaimed')
    .map((item) => ({
      id: item.stagingId,
      clientId: item.entry.clientId,
      batchId: batch.batchId,
      bodyCode: item.entry.bodyCode,
      attendant: item.entry.attendant,
      date: item.entry.date,
      tempC: item.entry.tempC,
      humidityPct: item.entry.humidityPct,
      inAt: item.entry.inAt,
      outAt: item.entry.outAt,
      verdict: item.verdict,
      status: 'unclaimed',
      claimedBodyId: null,
      createdAt: mergedAt,
      updatedAt: mergedAt,
    }));

  // 越界胎体：只挂「没做完」的道次（state !== done），已完成道次不动
  const overBodyIds = new Set(
    roomRows.filter((room) => room.verdict !== 'suitable').map((room) => room.bodyId),
  );
  const recheckBodyIds = [...overBodyIds];
  const coatsToRecheck = coats.filter(
    (coat) => overBodyIds.has(coat.bodyId) && coat.state !== 'done',
  );

  const record: SyncBatchRecord = {
    ...batch,
    id: batch.batchId,
    status: 'merged',
    mergedAt,
    summary: preview.summary,
  };

  await db.transaction('rw', db.rooms, db.coats, db.syncStaging, db.syncBatches, async () => {
    if (roomRows.length > 0) await db.rooms.bulkPut(roomRows);
    if (stagingRows.length > 0) await db.syncStaging.bulkPut(stagingRows);
    if (coatsToRecheck.length > 0) {
      const now = Date.now();
      await db.coats.bulkPut(
        coatsToRecheck.map((coat) => ({ ...coat, needRecheck: true, updatedAt: now })),
      );
    }
    await db.syncBatches.put(record);
  });

  return { batchId: batch.batchId, alreadyMerged: false, summary: preview.summary, record, recheckBodyIds };
}

/**
 * 认领待认领记录：并入指定胎体；若越界，把该胎体没做完的道次挂待复检。
 * 单事务，失败不改原暂存。认领后从暂存表移除（正式记录已在 rooms）。
 */
export async function claimStagingRoom(stagingId: string, bodyId: string): Promise<void> {
  const staging = await db.syncStaging.get(stagingId);
  if (!staging || staging.status !== 'unclaimed') return;
  const now = Date.now();
  await db.transaction('rw', db.rooms, db.coats, db.syncStaging, async () => {
    // 主键若已被占用（同 clientId 已并入），不重复落
    const existing = await db.rooms.get(staging.clientId);
    if (!existing) {
      await db.rooms.put({
        id: staging.clientId,
        bodyId,
        date: staging.date,
        tempC: staging.tempC,
        humidityPct: staging.humidityPct,
        inAt: staging.inAt,
        outAt: staging.outAt,
        verdict: staging.verdict,
        attendant: staging.attendant,
        syncBatchId: staging.batchId,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (staging.verdict !== 'suitable') {
      const pending = await db.coats
        .where('bodyId')
        .equals(bodyId)
        .filter((coat) => coat.state !== 'done')
        .toArray();
      if (pending.length > 0) {
        const stamp = Date.now();
        await db.coats.bulkPut(pending.map((coat) => ({ ...coat, needRecheck: true, updatedAt: stamp })));
      }
    }
    await db.syncStaging.delete(stagingId);
  });
}

/** 放弃待认领记录（编号确认无关）：仅删暂存，批次原档保留 */
export async function discardStagingRoom(stagingId: string): Promise<void> {
  await db.syncStaging.delete(stagingId);
}
