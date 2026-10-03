/**
 * /sync 荫房平板离线同步
 * 荫房无网：平板离线记入房 / 出房 / 温湿度，封班导出批次；回工作室后导入合并。
 * 规则：平板旧道次不回写、荫房记录只认值守那份、越界挂未完成道次待复检、
 *       编号对不上挂待认领（不挡并好的）、失败整批回滚、重送幂等不多出记录。
 * 消费 SyncDraft / SyncBatchRecord / SyncStagingRoom，并读取 Body / Coat 做匹配与漂移比对。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FileAddOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSyncStore } from '@/stores/syncStore';
import { readDeviceId } from '@/utils/db';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL } from '@/types/coat';
import { ROOM_VERDICT_COLOR, ROOM_VERDICT_LABEL } from '@/types/room';
import {
  createEmptySyncDraft,
  STAGING_STATUS_LABEL,
  type SyncBatch,
  type SyncDraft,
  type SyncDraftDraft,
} from '@/types/sync';
import { exportSyncBatchJson, readJsonFile } from '@/utils/export';
import {
  claimStagingRoom,
  discardStagingRoom,
  mergeSyncBatch,
  previewSyncBatch,
  sealSyncBatch,
  validateSyncBatch,
  type SyncPreview,
} from '@/utils/sync';
import { dewPoint, roomStayHours } from '@/utils/humidity';

export default function SyncBoard() {
  const [tab, setTab] = useState('tablet');
  const loadSync = useSyncStore((state) => state.loadSync);
  const ready = useSyncStore((state) => state.ready);

  useEffect(() => {
    if (!ready) void loadSync();
  }, [ready, loadSync]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房平板离线同步</h2>
          <p>
            荫房无网：平板离线记出入房与温湿度，封班导出，回工作室合并。平板上的旧道次不会带回去，
            越界未完成道次自动挂待复检，编号对不上先挂待认领。
          </p>
        </div>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'tablet', label: '平板离线录入', icon: <FileAddOutlined />, children: <TabletPane onSealed={() => setTab('merge')} /> },
          { key: 'merge', label: '回工作室合并', icon: <CloudUploadOutlined />, children: <MergePane /> },
          { key: 'staging', label: '待认领', icon: <SafetyCertificateOutlined />, children: <StagingPane /> },
        ]}
      />
    </div>
  );
}

/* ------------------------------ 平板离线录入 ------------------------------ */

function TabletPane({ onSealed }: { onSealed: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<SyncDraftDraft>();
  const fileNote = useRef<{ attendant: string; note: string }>({ attendant: '', note: '' });

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const drafts = useSyncStore((state) => state.drafts);
  const createDraft = useSyncStore((state) => state.createDraft);
  const updateDraft = useSyncStore((state) => state.updateDraft);
  const removeDraft = useSyncStore((state) => state.removeDraft);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SyncDraft | null>(null);
  const [sealOpen, setSealOpen] = useState(false);
  const [sealForm] = Form.useForm<{ attendant: string; note: string }>();
  const deviceId = useMemo(() => readDeviceId(), []);

  const openDrafts = useMemo(
    () => drafts.filter((draft) => draft.sealedBatchId === null),
    [drafts],
  );
  const sealedDrafts = useMemo(
    () => drafts.filter((draft) => draft.sealedBatchId !== null),
    [drafts],
  );

  const bodyLabel = (bodyId: string, code: string): string => {
    const body = bodies.find((item) => item.id === bodyId);
    return body ? body.code : code || bodyId;
  };

  const openCreate = (): void => {
    setEditing(null);
    const first = bodies[0];
    form.setFieldsValue(
      createEmptySyncDraft(first?.id ?? '', first?.code ?? '', fileNote.current.attendant),
    );
    setOpen(true);
  };

  const openEdit = (draft: SyncDraft): void => {
    setEditing(draft);
    form.setFieldsValue({
      bodyId: draft.bodyId,
      bodyCode: draft.bodyCode,
      attendant: draft.attendant,
      date: draft.date,
      tempC: draft.tempC,
      humidityPct: draft.humidityPct,
      inAt: draft.inAt,
      outAt: draft.outAt,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const body = bodies.find((item) => item.id === values.bodyId);
    const payload: SyncDraftDraft = {
      ...values,
      bodyCode: values.bodyCode?.trim() || body?.code || '',
    };
    fileNote.current.attendant = values.attendant;
    if (editing) {
      await updateDraft(editing.id, payload);
      message.success('已更新该条离线记录');
    } else {
      await createDraft(payload);
      message.success('已离线记入本机（无网也可继续录）');
    }
    setOpen(false);
  };

  const openSeal = (): void => {
    if (openDrafts.length === 0) {
      message.warning('本班还没有记录，无法封班');
      return;
    }
    sealForm.setFieldsValue({
      attendant: fileNote.current.attendant || openDrafts[0]?.attendant || '',
      note: '',
    });
    setSealOpen(true);
  };

  const doSeal = async (): Promise<void> => {
    const values = await sealForm.validateFields();
    const batch = await sealSyncBatch({
      deviceId,
      attendant: values.attendant,
      note: values.note,
      drafts: openDrafts,
      coats,
    });
    const filename = exportSyncBatchJson(batch);
    setSealOpen(false);
    message.success(`已封班导出 ${filename}（${batch.records.length} 条，草稿本机留底）`);
    onSealed();
  };

  const columns: ColumnsType<SyncDraft> = [
    { title: '日期', dataIndex: 'date', width: 110 },
    {
      title: '胎体编号',
      key: 'body',
      width: 130,
      render: (_v, record) => <Tag color="#8c2f1f">{bodyLabel(record.bodyId, record.bodyCode)}</Tag>,
    },
    { title: '入房', dataIndex: 'inAt', width: 80 },
    { title: '出房', dataIndex: 'outAt', width: 80 },
    {
      title: '在房',
      key: 'stay',
      width: 90,
      render: (_v, record) => `${roomStayHours(record.inAt, record.outAt)}h`,
    },
    { title: '温度', dataIndex: 'tempC', width: 70, render: (v: number) => `${v}℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 70, render: (v: number) => `${v}%` },
    { title: '值守', dataIndex: 'attendant', width: 90, render: (v: string) => v || '—' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该条离线记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeDraft(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="荫房无网，记录先存在这台平板本机（IndexedDB）"
        description="逐条登记出入房与温湿度；本班结束后「封班导出」生成批次文件，回工作室在「回工作室合并」页导入。封班后草稿仍在本机留底。"
      />

      <div className="gb-stat-row">
        <StatBadge label="本班未封班" value={openDrafts.length} suffix="条" tone="primary" />
        <StatBadge label="本机已封班留底" value={sealedDrafts.length} suffix="条" tone="info" />
        <StatBadge label="涉及胎体" value={new Set(openDrafts.map((d) => d.bodyCode || d.bodyId)).size} suffix="件" tone="success" />
      </div>

      <Card
        className="gb-table-card"
        title="本班离线记录"
        style={{ marginTop: 8 }}
        styles={{ body: { padding: 0 } }}
        extra={
          <Space>
            <Button type="primary" icon={<FileAddOutlined />} onClick={openCreate}>
              离线记一条

            </Button>
            <Button icon={<LockOutlined />} onClick={openSeal}>
              封班导出
            </Button>
          </Space>
        }
      >
        {openDrafts.length === 0 ? (
          <EmptyPanel
            title="本班还没有离线记录"
            description="点「离线记一条」登记入房、出房与温湿度；无网络也能连续录入。"
            actionText="离线记一条"
            onAction={openCreate}
            size="small"
          />
        ) : (
          <Table<SyncDraft> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={openDrafts} />
        )}
      </Card>

      {sealedDrafts.length > 0 ? (
        <Card size="small" style={{ marginTop: 16 }} title="本机已封班留底（批次号）">
          <Space size={[6, 6]} wrap>
            {[...new Set(sealedDrafts.map((draft) => draft.sealedBatchId as string))].map((batchId) => (
              <Tag key={batchId}>{batchId}</Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      <Modal
        open={open}
        title={editing ? '编辑离线记录' : '离线记一条（入房 / 出房 / 温湿度）'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存到本机"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="bodyId" label="在荫胎体（可选，找不到就只填编号）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="选择胎体，或留空只填下方编号"
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
              }))}
              onChange={(value: string | undefined) => {
                const body = bodies.find((item) => item.id === value);
                if (body) form.setFieldValue('bodyCode', body.code);
              }}
            />
          </Form.Item>
          <Form.Item
            name="bodyCode"
            label="胎体编号"
            rules={[{ required: true, message: '请填写胎体编号（编号对得上才能直接并入）' }]}
          >
            <Input placeholder="如 LQ-2401" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inAt" label="入房" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="tempC" label="温度（℃）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={45} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="humidityPct" label="湿度（%）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="attendant" label="值守" style={{ flex: 1 }}>
              <Input placeholder="值守人" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        open={sealOpen}
        title="封班导出同步批次"
        onCancel={() => setSealOpen(false)}
        onOk={() => void doSeal()}
        okText="封班并导出文件"
        cancelText="再录几条"
        destroyOnClose
      >
        <Form form={sealForm} layout="vertical" preserve={false}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`将把本班 ${openDrafts.length} 条记录与当前道次快照一起打包`}
            description="道次快照只用于回工作室时判断「哪些道已被管理员推进」，不会用平板上的旧道次覆盖档案。"
          />
          <Form.Item name="attendant" label="本班值守人" rules={[{ required: true, message: '请填写值守人' }]}>
            <Input placeholder="如：值守 老赵" />
          </Form.Item>
          <Form.Item name="note" label="班次备注">
            <Input.TextArea rows={2} placeholder="如：9月30日夜班，2号荫房" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/* ------------------------------ 回工作室合并 ------------------------------ */

function MergePane() {
  const { message } = AntdApp.useApp();
  const fileRef = useRef<HTMLInputElement>(null);

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const rooms = useRoomStore((state) => state.rooms);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const loadRooms = useRoomStore((state) => state.loadRooms);
  const batches = useSyncStore((state) => state.batches);
  const refreshAfterMerge = useSyncStore((state) => state.refreshAfterMerge);

  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [batchFile, setBatchFile] = useState<SyncBatch | null>(null);
  const [merging, setMerging] = useState(false);

  const pickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = await readJsonFile(file);
    } catch {
      message.error('JSON 解析失败，请确认是封班导出的批次文件');
      return;
    }
    const invalid = validateSyncBatch(parsed);
    if (invalid) {
      message.error(invalid);
      return;
    }
    const batch = parsed as SyncBatch;
    const already = batches.some((item) => item.id === batch.batchId);
    const existingRoomIds = new Set(rooms.map((room) => room.id));
    const next = previewSyncBatch(batch, bodies, coats, existingRoomIds, already);
    setBatchFile(batch);
    setPreview(next);
    if (already) message.info('该批次已经合并过，重复导入将直接跳过，不会多出记录');
  };

  const doMerge = async (): Promise<void> => {
    if (!batchFile) return;
    setMerging(true);
    try {
      const result = await mergeSyncBatch(batchFile);
      await Promise.all([loadCoats(), loadRooms(), refreshAfterMerge()]);
      if (result.alreadyMerged) {
        message.info('该批次此前已合并，本次直接跳过，未新增记录');
      } else {
        message.success(
          `合并完成：并入 ${result.summary.merged} 条，待认领 ${result.summary.unclaimed} 条，重复跳过 ${result.summary.duplicate} 条`,
        );
      }
      setPreview(null);
      setBatchFile(null);
    } catch (error) {
      message.error(`合并失败，已整批回滚，工序台账不变：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setMerging(false);
    }
  };

  const batchColumns: ColumnsType<(typeof batches)[number]> = [
    { title: '批次号', dataIndex: 'id', width: 180, render: (v: string) => <Typography.Text copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Typography.Text> },
    { title: '封班时间', dataIndex: 'sealedAt', width: 170, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '值守', dataIndex: 'attendant', width: 90 },
    {
      title: '并入/待认领/重复',
      key: 'summary',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          <Tag color="green">{record.summary.merged}</Tag>
          <Tag color="gold">{record.summary.unclaimed}</Tag>
          <Tag>{record.summary.duplicate}</Tag>
        </Space>
      ),
    },
    { title: '越界', dataIndex: ['summary', 'overCount'], width: 70, render: (v: number) => <Tag color="red">{v}</Tag> },
    { title: '管理员已推进道次', dataIndex: ['summary', 'pushedCoats'], width: 140, render: (v: number) => (v > 0 ? <Tag color="blue">{v} 道（未回退）</Tag> : '—') },
    { title: '备注', dataIndex: 'note', render: (v: string) => v || '—' },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap>
            <Button type="primary" icon={<ExportOutlined />} onClick={() => fileRef.current?.click()}>
              选择平板批次文件
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(event) => void pickFile(event)}
            />
            <Typography.Text type="secondary">选文件后先预览，确认再合并。</Typography.Text>
          </Space>

          {preview ? (
            <PreviewCard preview={preview} merging={merging} onMerge={() => void doMerge()} onCancel={() => { setPreview(null); setBatchFile(null); }} />
          ) : (
            <Alert
              type="info"
              showIcon
              message="合并规则"
              description="只并入荫房记录并按越界回写未完成道次的待复检标记；不写胎体与道次台账。编号对得上直接并入，对不上挂待认领。同一批次再送一次自动跳过。"
            />
          )}
        </Space>
      </Card>

      <Card className="gb-table-card" title="档案留底：已合并批次（两边各自留底）" styles={{ body: { padding: 0 } }}>
        {batches.length === 0 ? (
          <EmptyPanel title="还没有合并过批次" description="把平板封班导出的 JSON 批次文件选进来即可预览、合并。" size="small" />
        ) : (
          <Table rowKey="id" size="small" pagination={{ pageSize: 6 }} columns={batchColumns} dataSource={batches} />
        )}
      </Card>
    </div>
  );
}

function PreviewCard({
  preview,
  merging,
  onMerge,
  onCancel,
}: {
  preview: SyncPreview;
  merging: boolean;
  onMerge: () => void;
  onCancel: () => void;
}) {
  const { summary, outcomes, drifts, alreadyMerged, batch } = preview;

  const mergedRows = outcomes.filter((item) => item.kind === 'merged');
  const unclaimedRows = outcomes.filter((item) => item.kind === 'unclaimed');
  const duplicateRows = outcomes.filter((item) => item.kind === 'duplicate');

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Tag color="#8c2f1f">{batch.attendant || '未填值守'}</Tag>
        <Typography.Text type="secondary">封班 {new Date(batch.sealedAt).toLocaleString('zh-CN')}</Typography.Text>
        {batch.note ? <Typography.Text type="secondary">备注：{batch.note}</Typography.Text> : null}
      </Space>

      <div className="gb-stat-row">
        <StatBadge label="本批总数" value={summary.total} suffix="条" tone="primary" />
        <StatBadge label="可并入" value={summary.merged} suffix="条" tone="success" />
        <StatBadge label="挂待认领" value={summary.unclaimed} suffix="条" tone="warning" />
        <StatBadge label="重复跳过" value={summary.duplicate} suffix="条" />
        <StatBadge label="越界回写待复检" value={summary.overCount} suffix="条" tone="danger" />
        <StatBadge label="管理员已推进道次" value={summary.pushedCoats} suffix="道" tone="info" />
      </div>

      {alreadyMerged ? (
        <Alert type="info" showIcon style={{ marginTop: 8 }} message="该批次已在档案中合并过；确认合并将直接跳过，不新增任何记录。" />
      ) : null}

      {drifts.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message={`检测到 ${drifts.length} 个道次已被工序管理员在档案侧推进，合并不会把平板上的旧状态带回去`}
          description={
            <Space size={[4, 4]} wrap>
              {drifts.map((drift) => (
                <Tag key={drift.coatId} color="blue">
                  {drift.bodyCode} 第{drift.seq}道 {drift.colorName}：
                  {COAT_STATE_LABEL[drift.tabletState]} → {COAT_STATE_LABEL[drift.archiveState]}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : (
        <Alert type="success" showIcon style={{ marginTop: 8 }} message="没有道次漂移：平板快照与档案道次状态一致，无需回退处理。" />
      )}

      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col xs={24} lg={12}>
          <Card size="small" title={`可并入（${mergedRows.length}）`} styles={{ body: { padding: 0 } }}>
            <OutcomeTable rows={mergedRows} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title={`待认领（${unclaimedRows.length}，不挡上面并入）`} styles={{ body: { padding: 0 } }}>
            <OutcomeTable rows={unclaimedRows} />
          </Card>
        </Col>
      </Row>
      {duplicateRows.length > 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          另有 {duplicateRows.length} 条档案中已存在（按平板记录主键识别），合并时跳过。
        </Typography.Text>
      ) : null}

      <Space style={{ marginTop: 12 }}>
        <Button type="primary" loading={merging} disabled={alreadyMerged && summary.merged === 0 && summary.unclaimed === 0} onClick={onMerge}>
          确认合并
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </Space>
    </div>
  );
}

function OutcomeTable({ rows }: { rows: SyncPreview['outcomes'] }) {
  if (rows.length === 0) return <Typography.Text type="secondary" style={{ display: 'block', padding: 12 }}>无</Typography.Text>;
  return (
    <Table
      rowKey={(row) => (row.kind === 'unclaimed' ? row.stagingId : row.entry.clientId)}
      size="small"
      pagination={false}
      scroll={{ y: 200 }}
      dataSource={rows}
      columns={[
        {
          title: '日期',
          dataIndex: ['entry', 'date'],
          width: 96,
        },
        {
          title: '编号',
          key: 'code',
          width: 96,
          render: (_v, row) => <Tag color="#8c2f1f">{row.entry.bodyCode || row.entry.bodyId}</Tag>,
        },
        { title: '温/湿', key: 'env', width: 92, render: (_v, row) => `${row.entry.tempC}℃/${row.entry.humidityPct}%` },
        {
          title: '判定',
          key: 'verdict',
          width: 80,
          render: (_v, row) => {
            const verdict = row.kind === 'merged' || row.kind === 'unclaimed' ? row.verdict : 'suitable';
            return <Tag color={ROOM_VERDICT_COLOR[verdict]}>{ROOM_VERDICT_LABEL[verdict]}</Tag>;
          },
        },
        {
          title: '落点',
          key: 'kind',
          render: (_v, row) =>
            row.kind === 'merged' ? <Tag color="green">并入</Tag> : row.kind === 'unclaimed' ? <Tag color="gold">待认领</Tag> : <Tag>重复</Tag>,
        },
      ]}
    />
  );
}

/* ------------------------------ 待认领 ------------------------------ */

function StagingPane() {
  const { message } = AntdApp.useApp();
  const bodies = useBodyStore((state) => state.bodies);
  const loadCoats = useCoatStore((state) => state.loadCoats);
  const loadRooms = useRoomStore((state) => state.loadRooms);
  const staging = useSyncStore((state) => state.staging);
  const refreshAfterMerge = useSyncStore((state) => state.refreshAfterMerge);

  const [claimId, setClaimId] = useState<string | null>(null);
  const [claimForm] = Form.useForm<{ bodyId: string }>();
  const [onlyUnclaimed, setOnlyUnclaimed] = useState(true);

  const visible = useMemo(
    () => staging.filter((row) => (onlyUnclaimed ? row.status === 'unclaimed' : true)),
    [staging, onlyUnclaimed],
  );

  const openClaim = (id: string): void => {
    setClaimId(id);
    claimForm.setFieldsValue({ bodyId: bodies[0]?.id ?? '' });
  };

  const doClaim = async (): Promise<void> => {
    if (!claimId) return;
    const { bodyId } = await claimForm.validateFields();
    await claimStagingRoom(claimId, bodyId);
    await Promise.all([loadCoats(), loadRooms(), refreshAfterMerge()]);
    setClaimId(null);
    message.success('已认领并入；若该记录越界，已回写该胎体未完成道次为待复检');
  };

  const doDiscard = async (id: string): Promise<void> => {
    await discardStagingRoom(id);
    await refreshAfterMerge();
    message.success('已放弃该待认领记录（批次原档仍留底）');
  };

  const columns: ColumnsType<(typeof staging)[number]> = [
    { title: '日期', dataIndex: 'date', width: 100 },
    {
      title: '对不上的编号',
      dataIndex: 'bodyCode',
      width: 140,
      render: (v: string) => <Tag color="gold">{v || '（空）'}</Tag>,
    },
    { title: '入房', dataIndex: 'inAt', width: 70 },
    { title: '出房', dataIndex: 'outAt', width: 70 },
    {
      title: '在房',
      key: 'stay',
      width: 80,
      render: (_v, record) => `${roomStayHours(record.inAt, record.outAt)}h`,
    },
    { title: '温/湿', key: 'env', width: 100, render: (_v, r) => `${r.tempC}℃/${r.humidityPct}%` },
    {
      title: '露点',
      key: 'dew',
      width: 80,
      render: (_v, r) => `${dewPoint(r.tempC, r.humidityPct)}℃`,
    },
    {
      title: '判定',
      dataIndex: 'verdict',
      width: 80,
      render: (v: (typeof staging)[number]['verdict']) => (
        <Tag color={ROOM_VERDICT_COLOR[v]}>{ROOM_VERDICT_LABEL[v]}</Tag>
      ),
    },
    { title: '值守', dataIndex: 'attendant', width: 80, render: (v: string) => v || '—' },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: keyof typeof STAGING_STATUS_LABEL) => <Tag color={v === 'unclaimed' ? 'gold' : 'default'}>{STAGING_STATUS_LABEL[v]}</Tag> },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, record) =>
        record.status === 'unclaimed' ? (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => openClaim(record.id)}>
              认领并入
            </Button>
            <Popconfirm
              title="放弃该记录？"
              description="仅从待认领移除，批次原档仍保留。"
              okText="放弃"
              cancelText="取消"
              onConfirm={() => void doDiscard(record.id)}
            >
              <Button size="small" type="link" danger>
                放弃
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>已处理</Typography.Text>
        ),
    },
  ];

  return (
    <Card
      className="gb-table-card"
      title="编号对不上的荫房记录"
      styles={{ body: { padding: 0 } }}
      extra={
        <Space>
          <Typography.Text type="secondary">
            待认领 {staging.filter((s) => s.status === 'unclaimed').length} 条
          </Typography.Text>
          <Button size="small" type={onlyUnclaimed ? 'primary' : 'default'} onClick={() => setOnlyUnclaimed((v) => !v)}>
            {onlyUnclaimed ? '显示已认领' : '只看待认领'}
          </Button>
        </Space>
      }
    >
      {visible.length === 0 ? (
        <EmptyPanel
          title="没有待认领记录"
          description="批次里编号都能对上时不会进这里；对不上的记录会先挂着，不影响其余记录并入。"
          size="small"
        />
      ) : (
        <Table rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={visible} />
      )}

      <Modal
        open={claimId !== null}
        title="认领并并入到哪个胎体"
        onCancel={() => setClaimId(null)}
        onOk={() => void doClaim()}
        okText="认领并入"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={claimForm} layout="vertical" preserve={false}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="该荫房记录将以值守填的值并入所选胎体；若判定越界，会把该胎体没做完的道次挂待复检。"
          />
          <Form.Item name="bodyId" label="选择胎体" rules={[{ required: true, message: '请选择胎体' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]} · ${body.ownerName || '无藏家'}`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
