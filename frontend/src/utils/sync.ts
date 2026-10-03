/**
 * 荫房平板离线同步引擎
 * 规则（与业务约定逐字对应）：
 * 1. 只合并荫房记录（Room），不回写道次（Coat）；Coat 快照仅随批次留底；
 * 2. 荫房记录只认值守填的那份：温湿度 / 出入房时间 / 日期原样入库，判定按档案统一规则复判，
 *    值守原始判定存入 Room.tabletVerdict 留底；
 * 3. 荫干窗口一越界，该胎体没做完的道次（非「已完成」）挂待复检；
 * 4. bodyId 与编号都对不上的条次挂「待认领」，不阻断同批其他条次；
 * 5. 合并为单事务（rooms + coats + syncBatches），中途失败整批回滚，工序台账零变化；
 * 6. 已合并条次按 clientId 判重，再送一次只跳过、不多出记录。
 */
import { db, createId } from './db';
import { judgeVerdict } from './humidity';
import type { Body } from '@/types/body';
import type { Room, RoomVerdict } from '@/types/room';
import type {
  CoatSnapshot,
  RoomSyncEntry,
  SyncBatch,
  SyncBatchInput,
  SyncEntryStatus,
} from '@/types/sync';

/** 条次的预合并解析结果 */
export interface PlannedEntry {
  entry: RoomSyncEntry;
  /** 解析到的档案胎体（null = 待认领） */
  body: Body | null;
  /** 档案侧统一规则复判结果 */
  officialVerdict: RoomVerdict;
  /** 与档案中已有荫房记录的 clientId 撞车 → 重复跳过 */
  duplicate: boolean;
}

export interface SyncPlan {
  /** 本次真正要写入档案的条次 */
  toMerge: PlannedEntry[];
  /** 已在档案中、再送时跳过的条次 */
  duplicates: PlannedEntry[];
  /** 编号对不上、挂待认领的条次 */
  unresolved: PlannedEntry[];
  /** 越界条次命中的胎体（用于回写未完成道次为待复检） */
  recheckBodyIds: string[];
}

/** 解析条次关联的胎体：优先认领结果，其次 bodyId，最后按胎体编号 code */
export function resolveBody(entry: RoomSyncEntry, bodies: Body[]): Body | null {
  if (entry.resolvedBodyId) {
    return bodies.find((body) => body.id === entry.resolvedBodyId) ?? null;
  }
  const ref = entry.bodyRef.trim();
  if (!ref) return null;
  return bodies.find((body) => body.id === ref) ?? bodies.find((body) => body.code === ref) ?? null;
}

/** 预演一次合并，不写库；页面用于合并前确认与批次状态总览 */
export function planSync(batch: SyncBatch, bodies: Body[], archiveRooms: Room[]): SyncPlan {
  const existingClientIds = new Set(
    archiveRooms.map((room) => room.sourceClientId).filter((value): value is string => Boolean(value)),
  );
  const toMerge: PlannedEntry[] = [];
  const duplicates: PlannedEntry[] = [];
  const unresolved: PlannedEntry[] = [];

  batch.entries.forEach((entry) => {
    // 已合并条次再送：档案中已有同一 clientId → 重复跳过，绝不再写一条
    if (entry.status === 'merged') return;
    const planned: PlannedEntry = {
      entry,
      body: resolveBody(entry, bodies),
      officialVerdict: judgeVerdict(entry.tempC, entry.humidityPct),
      duplicate: existingClientIds.has(entry.clientId),
    };
    if (planned.duplicate) {
      duplicates.push(planned);
    } else if (!planned.body) {
      unresolved.push(planned);
    } else {
      toMerge.push(planned);
    }
  });

  const recheckBodyIds = Array.from(
    new Set(
      toMerge
        .filter((item) => item.officialVerdict !== 'suitable')
        .map((item) => item.body?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  return { toMerge, duplicates, unresolved, recheckBodyIds };
}

/** 生成下一个批次业务编号：SYNC-YYMMDD-序号（按当天已有批次数 +1） */
export function nextBatchCode(existing: SyncBatch[]): string {
  const today = new Date();
  const yy = String(today.getFullYear()).slice(2);
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const prefix = `SYNC-${yy}${mm}${dd}-`;
  const seq = existing.filter((batch) => batch.code.startsWith(prefix)).length + 1;
  return `${prefix}${String(seq).padStart(2, '0')}`;
}

/** 平板侧：把一批离线记录落为同步批次，并冻结同步前的道次快照（仅留底） */
export async function createSyncBatch(input: SyncBatchInput): Promise<SyncBatch> {
  const now = Date.now();
  const [bodies, coats, existing] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.syncBatches.toArray(),
  ]);
  const batchId = createId('syncbatch');

  const entries: RoomSyncEntry[] = input.entries.map((item) => {
    const ref = item.bodyRef.trim();
    const body = bodies.find((candidate) => candidate.id === ref) ?? bodies.find((candidate) => candidate.code === ref);
    return {
      entryId: createId('entry'),
      clientId: `${batchId}:${createId('rec').slice(-8)}`,
      bodyRef: ref,
      date: item.date,
      tempC: item.tempC,
      humidityPct: item.humidityPct,
      inAt: item.inAt,
      outAt: item.outAt,
      tabletVerdict: item.tabletVerdict,
      status: 'pending',
      roomId: null,
      resolvedBodyId: null,
      note: body ? '' : '编号在档案中暂无匹配，合并时将挂待认领',
    };
  });

  // 冻结同步前道次：只对能匹配到胎体的条次分组快照；匹配不上的不进快照
  const snapshotBodyIds = Array.from(
    new Set(
      entries
        .map((entry) => resolveBody(entry, bodies)?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const coatSnapshots = snapshotBodyIds.map((bodyId) => {
    const body = bodies.find((candidate) => candidate.id === bodyId);
    const snapshotCoats: CoatSnapshot[] = coats
      .filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq)
      .map((coat) => ({
        coatId: coat.id,
        seq: coat.seq,
        paintType: coat.paintType,
        colorName: coat.colorName,
        coatDate: coat.coatDate,
        state: coat.state,
        needRecheck: coat.needRecheck,
      }));
    return { bodyId, bodyCode: body?.code ?? bodyId, coats: snapshotCoats };
  });

  const batch: SyncBatch = {
    id: batchId,
    code: nextBatchCode(existing),
    watcherName: input.watcherName.trim(),
    dispatchedAt: now,
    mergedAt: null,
    status: 'open',
    entries,
    coatSnapshots,
    mergedCount: 0,
    unclaimedCount: 0,
    duplicateCount: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
  };
  await db.syncBatches.put(batch);
  return batch;
}

export interface SyncApplyResult {
  batch: SyncBatch;
  plan: SyncPlan;
}

/** 按条次 clientId / 状态重算批次内三个计数 */
function recount(entries: RoomSyncEntry[]): Pick<SyncBatch, 'mergedCount' | 'unclaimedCount' | 'duplicateCount'> {
  return {
    mergedCount: entries.filter((entry) => entry.status === 'merged').length,
    unclaimedCount: entries.filter((entry) => entry.status === 'unclaimed').length,
    duplicateCount: entries.filter((entry) => entry.status === 'duplicate').length,
  };
}

/**
 * 执行「合并入档案」。
 * - rooms / coats / syncBatches 在同一个可读写事务内：任何一步抛错，
 *   本批已写的荫房记录与待复检回写全部回滚，工序台账照旧；
 * - simulateFailure 供页面演练中途失败（提交前抛错），验证不多出记录。
 */
export async function applySync(batchId: string, simulateFailure = false): Promise<SyncApplyResult> {
  const batch = await db.syncBatches.get(batchId);
  if (!batch) throw new Error('同步批次不存在或已被删除');

  const [bodies, archiveRooms] = await Promise.all([db.bodies.toArray(), db.rooms.toArray()]);
  const plan = planSync(batch, bodies, archiveRooms);
  const now = Date.now();

  const roomIdByClientId = new Map<string, string>();
  const newRooms: Room[] = plan.toMerge.map((item) => {
    const roomId = createId('room');
    roomIdByClientId.set(item.entry.clientId, roomId);
    return {
      id: roomId,
      bodyId: item.body?.id ?? '',
      date: item.entry.date,
      tempC: item.entry.tempC,
      humidityPct: item.entry.humidityPct,
      inAt: item.entry.inAt,
      outAt: item.entry.outAt,
      // 档案侧统一规则复判；值守原判只留底
      verdict: item.officialVerdict,
      watcherName: batch.watcherName,
      source: 'sync',
      sourceBatchId: batch.id,
      sourceClientId: item.entry.clientId,
      tabletVerdict: item.entry.tabletVerdict,
      createdAt: now,
      updatedAt: now,
    };
  });

  await db.transaction('rw', db.rooms, db.coats, db.syncBatches, async () => {
    if (newRooms.length > 0) await db.rooms.bulkAdd(newRooms);

    // 荫干窗口越界：没做完的道次（非「已完成」）挂待复检；只置位，不清原有标记
    for (const bodyId of plan.recheckBodyIds) {
      const bodyCoats = await db.coats.where('bodyId').equals(bodyId).toArray();
      const toMark = bodyCoats.filter((coat) => coat.state !== 'done' && !coat.needRecheck);
      if (toMark.length > 0) {
        await db.coats.bulkPut(toMark.map((coat) => ({ ...coat, needRecheck: true, updatedAt: now })));
      }
    }

    if (simulateFailure) {
      throw new Error('演练：批次写入中途失败，事务整体回滚');
    }

    const nextEntries: RoomSyncEntry[] = batch.entries.map((entry) => {
      if (entry.status === 'merged') return entry;
      const mergedItem = plan.toMerge.find((item) => item.entry.entryId === entry.entryId);
      if (mergedItem) {
        return {
          ...entry,
          status: 'merged' as SyncEntryStatus,
          roomId: roomIdByClientId.get(entry.clientId) ?? null,
          resolvedBodyId: mergedItem.body?.id ?? null,
          note: '',
        };
      }
      const duplicateItem = plan.duplicates.find((item) => item.entry.entryId === entry.entryId);
      if (duplicateItem) {
        return { ...entry, status: 'duplicate' as SyncEntryStatus, note: '档案中已有该条记录，重复跳过' };
      }
      const unresolvedItem = plan.unresolved.find((item) => item.entry.entryId === entry.entryId);
      if (unresolvedItem) {
        return {
          ...entry,
          status: 'unclaimed' as SyncEntryStatus,
          note: entry.resolvedBodyId ? '原编号已失效，请重新认领胎体' : '编号在档案中匹配不到胎体',
        };
      }
      return entry;
    });

    const counts = recount(nextEntries);
    const everMerged = batch.status === 'merged' || counts.mergedCount > 0;
    const updatedBatch: SyncBatch = {
      ...batch,
      entries: nextEntries,
      status: everMerged ? 'merged' : 'open',
      mergedAt: now,
      lastError: '',
      updatedAt: now,
      ...counts,
    };
    await db.syncBatches.put(updatedBatch);
  });

  const refreshed = await db.syncBatches.get(batchId);
  if (!refreshed) throw new Error('合并后批次丢失');
  return { batch: refreshed, plan };
}

/**
 * 认领：把待认领条次挂到档案中的真实胎体上。
 * 认领本身不写荫房记录；下次「合并入档案」时随批并入（仍走幂等与越界回写）。
 */
export async function claimEntry(batchId: string, entryId: string, bodyId: string): Promise<SyncBatch> {
  const [batch, body] = await Promise.all([db.syncBatches.get(batchId), db.bodies.get(bodyId)]);
  if (!batch) throw new Error('同步批次不存在');
  if (!body) throw new Error('认领的胎体不在档案中');
  const entry = batch.entries.find((item) => item.entryId === entryId);
  if (!entry) throw new Error('条次不存在');
  if (entry.status === 'merged' || entry.status === 'duplicate') {
    throw new Error('该条次已并入档案，无需认领');
  }

  const nextEntries = batch.entries.map((item) =>
    item.entryId === entryId
      ? {
          ...item,
          resolvedBodyId: body.id,
          bodyRef: body.code || body.id,
          note: `已认领为 ${body.code}，待下次合并`,
        }
      : item,
  );
  const updated: SyncBatch = { ...batch, entries: nextEntries, updatedAt: Date.now(), ...recount(nextEntries) };
  await db.syncBatches.put(updated);
  return updated;
}

/** 删除一个离线批次（仅删平板侧留底；已并入档案的荫房记录不动） */
export async function removeSyncBatch(batchId: string): Promise<void> {
  await db.syncBatches.delete(batchId);
}
