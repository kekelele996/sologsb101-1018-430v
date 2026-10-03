/**
 * /sync 荫房值守平板 · 离线批次与合并工作台
 * 荫房无网：值守在平板上离线记的入房 / 出房与温湿度成批带回，在此「合并入档案」。
 *
 * 合并约定：
 * - 只并荫房记录，不回写道次（冻结道次快照仅供留底比对，差异给出警示）；
 * - 越界条次只把「没做完」的道次挂待复检，胎体卡片与越界统计随后自动更新；
 * - 编号对不上的条次挂待认领，不挡同批其他条次，认领后随下次合并并入；
 * - 单事务合并：演练中途失败可验证整批回滚、台账零变化；再送一次按条次幂等，不多出记录。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  TabletOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSyncStore } from '@/stores/syncStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { COAT_STATE_LABEL, PAINT_TYPE_LABEL } from '@/types/coat';
import {
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  type RoomVerdict,
} from '@/types/room';
import {
  SYNC_BATCH_STATUS_COLOR,
  SYNC_BATCH_STATUS_LABEL,
  SYNC_ENTRY_STATUS_COLOR,
  SYNC_ENTRY_STATUS_LABEL,
  type RoomSyncEntry,
  type SyncBatch,
  type SyncBatchInput,
  type SyncBatchStatus,
} from '@/types/sync';
import { judgeVerdict, roomStayHours } from '@/utils/humidity';
import { planSync, type PlannedEntry, type SyncPlan } from '@/utils/sync';

interface EntryFormItem {
  bodyRef: string;
  date: string;
  tempC: number;
  humidityPct: number;
  inAt: string;
  outAt: string;
}

interface BatchFormValues {
  watcherName: string;
  entries: EntryFormItem[];
}

const DEFAULT_ENTRY: EntryFormItem = {
  bodyRef: '',
  date: new Date().toISOString().slice(0, 10),
  tempC: 24,
  humidityPct: 75,
  inAt: '09:00',
  outAt: '21:00',
};

function formatTime(value: number | null): string {
  if (value === null) return '尚未合并';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function SyncCenter() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<BatchFormValues>();

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const rooms = useRoomStore((state) => state.rooms);
  const batches = useSyncStore((state) => state.batches);
  const createBatch = useSyncStore((state) => state.createBatch);
  const mergeBatch = useSyncStore((state) => state.mergeBatch);
  const claimEntry = useSyncStore((state) => state.claimEntry);
  const removeBatch = useSyncStore((state) => state.removeBatch);

  const [createOpen, setCreateOpen] = useState(false);
  const [planBatch, setPlanBatch] = useState<SyncBatch | null>(null);
  const [simulate, setSimulate] = useState(false);
  const [claiming, setClaiming] = useState<{ batchId: string; entry: RoomSyncEntry } | null>(null);
  const [claimBodyId, setClaimBodyId] = useState<string | undefined>();

  const bodyOptions = useMemo(
    () =>
      bodies.map((body) => ({
        value: body.code,
        label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
      })),
    [bodies],
  );

  const bodyIdOptions = useMemo(
    () =>
      bodies.map((body) => ({
        value: body.id,
        label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
      })),
    [bodies],
  );

  const stat = useMemo(() => {
    const open = batches.filter((batch) => batch.status === 'open').length;
    const failed = batches.filter((batch) => batch.status === 'failed').length;
    const mergedBatches = batches.filter((batch) => batch.status === 'merged').length;
    const unclaimed = batches.reduce((sum, batch) => sum + batch.unclaimedCount, 0);
    const mergedEntries = batches.reduce((sum, batch) => sum + batch.mergedCount, 0);
    return { open, failed, mergedBatches, unclaimed, mergedEntries };
  }, [batches]);

  const openCreate = (): void => {
    if (bodies.length === 0) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    form.resetFields();
    form.setFieldsValue({
      watcherName: '',
      entries: [DEFAULT_ENTRY, { ...DEFAULT_ENTRY }],
    });
    setCreateOpen(true);
  };

  const submitCreate = async (): Promise<void> => {
    const values = await form.validateFields();
    const input: SyncBatchInput = {
      watcherName: values.watcherName,
      entries: values.entries.map((entry) => ({
        bodyRef: entry.bodyRef,
        date: entry.date,
        tempC: entry.tempC,
        humidityPct: entry.humidityPct,
        inAt: entry.inAt,
        outAt: entry.outAt,
        tabletVerdict: judgeVerdict(entry.tempC, entry.humidityPct),
      })),
    };
    const batch = await createBatch(input);
    const unclaimed = batch.entries.filter((entry) => entry.status === 'unclaimed').length;
    message.success(
      `批次 ${batch.code} 已在平板留底（${batch.entries.length} 条${unclaimed > 0 ? `，${unclaimed} 条编号待认领` : ''}），回工作室后合并入档案`,
    );
    setCreateOpen(false);
  };

  const planOf = (batch: SyncBatch): SyncPlan => planSync(batch, bodies, rooms);

  const openPlan = (batch: SyncBatch, simulateFailure: boolean): void => {
    setPlanBatch(batch);
    setSimulate(simulateFailure);
  };

  const closePlan = (): void => {
    setPlanBatch(null);
    setSimulate(false);
  };

  const confirmMerge = async (): Promise<void> => {
    if (!planBatch) return;
    const target = planBatch;
    try {
      const merged = await mergeBatch(target.id, simulate);
      if (simulate) return; // 失败路径在 catch
      const parts: string[] = [`并入 ${merged.mergedCount} 条荫房记录`];
      if (merged.unclaimedCount > 0) parts.push(`${merged.unclaimedCount} 条待认领`);
      if (merged.duplicateCount > 0) parts.push(`${merged.duplicateCount} 条重复跳过`);
      message.success(`批次 ${merged.code} 合并完成：${parts.join('，')}`);
      closePlan();
    } catch (error) {
      message.error(
        `${simulate ? '演练' : ''}中途失败，本批已整体回滚、工序台账照旧：${
          error instanceof Error ? error.message : '未知错误'
        }。批次仍在平板留底，可再送一次。`,
      );
      closePlan();
    }
  };

  const submitClaim = async (): Promise<void> => {
    if (!claiming || !claimBodyId) return;
    await claimEntry(claiming.batchId, claiming.entry.entryId, claimBodyId);
    message.success('已认领，下次合并时随批并入，不影响已并好的记录');
    setClaiming(null);
    setClaimBodyId(undefined);
  };

  /** 冻结道次快照与档案当前道次的差异（平板存的是同步前道次，不能把管理员推进过的道次带回去） */
  const snapshotDrift = (batch: SyncBatch): Array<{ bodyCode: string; drift: number }> =>
    batch.coatSnapshots.map((group) => {
      const current = coats
        .filter((coat) => coat.bodyId === group.bodyId)
        .sort((a, b) => a.seq - b.seq);
      let drift = 0;
      if (current.length !== group.coats.length) {
        drift = Math.abs(current.length - group.coats.length);
      } else {
        current.forEach((coat, index) => {
          const snap = group.coats[index];
          if (!snap || snap.state !== coat.state || snap.needRecheck !== coat.needRecheck) drift += 1;
        });
      }
      return { bodyCode: group.bodyCode, drift };
    });

  const renderEntryTable = (batch: SyncBatch): React.ReactNode => {
    const entryColumns: ColumnsType<RoomSyncEntry> = [
      { title: '日期', dataIndex: 'date', width: 110 },
      {
        title: '关联编号',
        dataIndex: 'bodyRef',
        width: 120,
        render: (value: string, record) => {
          const body = bodies.find((item) => item.id === record.resolvedBodyId)
            ?? bodies.find((item) => item.id === value || item.code === value);
          return (
            <Space size={4} wrap>
              <Tag color="#8c2f1f">{value}</Tag>
              {body && body.code !== value ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  → {body.code}
                </Typography.Text>
              ) : null}
            </Space>
          );
        },
      },
      { title: '温度', dataIndex: 'tempC', width: 80, render: (v: number) => `${v}℃` },
      { title: '湿度', dataIndex: 'humidityPct', width: 80, render: (v: number) => `${v}%` },
      { title: '入房', dataIndex: 'inAt', width: 70 },
      { title: '出房', dataIndex: 'outAt', width: 70 },
      {
        title: '在房',
        key: 'stay',
        width: 90,
        render: (_v, record) => `${roomStayHours(record.inAt, record.outAt)}h`,
      },
      {
        title: '值守原判',
        dataIndex: 'tabletVerdict',
        width: 90,
        render: (value: RoomVerdict) => (
          <Tag style={{ opacity: 0.72 }} color={ROOM_VERDICT_COLOR[value]}>{ROOM_VERDICT_LABEL[value]}</Tag>
        ),
      },
      {
        title: '档案复判',
        key: 'official',
        width: 90,
        render: (_v, record) => {
          const verdict = judgeVerdict(record.tempC, record.humidityPct);
          const differs = verdict !== record.tabletVerdict;
          return (
            <Space size={2} direction="vertical">
              <Tag color={ROOM_VERDICT_COLOR[verdict]}>{ROOM_VERDICT_LABEL[verdict]}</Tag>
              {differs ? (
                <Typography.Text type="warning" style={{ fontSize: 11 }}>
                  与值守原判不一致，以复判为准
                </Typography.Text>
              ) : null}
            </Space>
          );
        },
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 100,
        render: (value: RoomSyncEntry['status']) => (
          <Tag color={SYNC_ENTRY_STATUS_COLOR[value]}>{SYNC_ENTRY_STATUS_LABEL[value]}</Tag>
        ),
      },
      {
        title: '备注 / 操作',
        dataIndex: 'note',
        render: (value: string, record) => (
          <Space size={6} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {value || '—'}
            </Typography.Text>
            {record.status === 'unclaimed' ? (
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setClaiming({ batchId: batch.id, entry: record });
                  setClaimBodyId(undefined);
                }}
              >
                认领胎体
              </Button>
            ) : null}
          </Space>
        ),
      },
    ];
    return (
      <Space direction="vertical" size={10} style={{ width: '100%', padding: '8px 4px' }}>
        <Table<RoomSyncEntry>
          rowKey="entryId"
          size="small"
          pagination={false}
          columns={entryColumns}
          dataSource={batch.entries}
        />
        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>
            同步前冻结道次（仅留底比对，不回写档案）
          </Typography.Text>
          {batch.coatSnapshots.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 0' }}>
              本批没有可匹配胎体的道次快照。
            </Typography.Paragraph>
          ) : (
            <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
              {batch.coatSnapshots.map((group) => {
                const drift = snapshotDrift(batch).find((item) => item.bodyCode === group.bodyCode)?.drift ?? 0;
                return (
                  <Card key={group.bodyId} size="small" styles={{ body: { padding: 8 } }}>
                    <Space size={8} wrap style={{ marginBottom: 6 }}>
                      <Tag color="#8c2f1f">{group.bodyCode}</Tag>
                      {drift > 0 ? (
                        <Tag color="warning">
                          {drift} 处与档案当前道次不同——档案以工序管理员推进后的为准，快照不带回
                        </Tag>
                      ) : (
                        <Tag color="success">与档案当前道次一致</Tag>
                      )}
                    </Space>
                    <Space size={8} wrap>
                      {group.coats.map((snap) => (
                        <Tag key={snap.coatId} style={{ fontSize: 12 }}>
                          第{snap.seq}道 · {PAINT_TYPE_LABEL[snap.paintType]} · {COAT_STATE_LABEL[snap.state]}
                          {snap.needRecheck ? ' · 待复检' : ''}
                        </Tag>
                      ))}
                    </Space>
                  </Card>
                );
              })}
            </Space>
          )}
        </div>
      </Space>
    );
  };

  const batchColumns: ColumnsType<SyncBatch> = [
    { title: '批次编号', dataIndex: 'code', width: 160 },
    {
      title: '值守',
      dataIndex: 'watcherName',
      width: 90,
      render: (value: string) => value || '未填写',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: SyncBatchStatus) => (
        <Tag color={SYNC_BATCH_STATUS_COLOR[value]}>{SYNC_BATCH_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '条次',
      key: 'entries',
      render: (_v, record) => (
        <Space size={4} wrap>
          <Tag color="success">并 {record.mergedCount}</Tag>
          <Tag color="error">待认领 {record.unclaimedCount}</Tag>
          <Tag color="processing">重复 {record.duplicateCount}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {record.entries.length} 条
          </Typography.Text>
        </Space>
      ),
    },
    { title: '带回时间', dataIndex: 'dispatchedAt', width: 170, render: (v: number) => formatTime(v) },
    { title: '最近合并', dataIndex: 'mergedAt', width: 170, render: (v: number | null) => formatTime(v) },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_v, record) => {
        const plan = planOf(record);
        const hasWork = plan.toMerge.length > 0;
        const hasUnclaimed = plan.unresolved.length > 0;
        const onlyDuplicates =
          plan.toMerge.length === 0 && plan.duplicates.length > 0 && plan.unresolved.length === 0;
        return (
          <Space size={4} wrap>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<MergeCellsOutlined />}
              disabled={!hasWork}
              onClick={() => openPlan(record, false)}
            >
              {onlyDuplicates ? '已全部在档' : '合并入档案'}
            </Button>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              disabled={!hasWork}
              onClick={() => openPlan(record, true)}
            >
              演练中途失败
            </Button>
            <Popconfirm
              title="删除平板批次留底"
              description="只删平板这批留底；已并入档案的荫房记录不动。"
              okText="确认删除"
              cancelText="取消"
              onConfirm={() =>
                void removeBatch(record.id).then(() => message.success('已删除该批次留底'))
              }
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
            {hasUnclaimed ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                展开行可认领 {plan.unresolved.length} 条
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const activePlan = planBatch ? planSync(planBatch, bodies, rooms) : null;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房值守平板 · 离线批次</h2>
          <p>
            荫房无网，值守用平板离线记入房 / 出房与温湿度，回工作室在此合并：只并荫房记录、不动道次；
            越界挂未完成道次待复检；编号对不上先挂待认领；中途失败整批回滚，再送幂等不多出记录。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          模拟平板新建批次
        </Button>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="待合并批次" value={stat.open} suffix="批" tone="warning" />
        <StatBadge label="失败留底" value={stat.failed} suffix="批" tone="danger" />
        <StatBadge label="已并条次" value={stat.mergedEntries} suffix="条" tone="success" />
        <StatBadge label="待认领条次" value={stat.unclaimed} suffix="条" tone="danger" />
        <StatBadge label="已完结批次" value={stat.mergedBatches} suffix="批" tone="info" />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="合并铁律"
        description={
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>荫房记录只认值守填的那份：温湿度 / 时间原样入库，判定按档案统一规则复判，值守原判留底。</li>
            <li>平板存的是同步前道次，只作冻结快照留底；并进来不把工序管理员推进过的道次带回去。</li>
            <li>荫干窗口越界，只把没做完的道次挂待复检，胎体卡片与越界统计随后自动更新。</li>
            <li>编号对不上先挂待认领、不挡并好的；认领后随下次合并并入。</li>
            <li>单事务合并，中途失败只退平板这批、工序台账照旧；再送一次按条次幂等，不多出记录。</li>
          </ol>
        }
      />

      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {batches.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text>平板上还没有离线批次留底</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  点「模拟平板新建批次」录入一批入出房与温湿度。
                </Typography.Text>
              </Space>
            }
            style={{ padding: 32 }}
          />
        ) : (
          <Table<SyncBatch>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 6 }}
            columns={batchColumns}
            dataSource={batches}
            expandable={{ expandedRowRender: (record) => renderEntryTable(record) }}
          />
        )}
      </Card>

      {/* 平板离线录入 */}
      <Modal
        open={createOpen}
        title="平板离线录入（荫房无网，回工作室再合并）"
        width={860}
        okText="存平板留底"
        cancelText="取消"
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={{ watcherName: '', entries: [DEFAULT_ENTRY] }}>
          <Form.Item
            name="watcherName"
            label="荫房值守人"
            rules={[{ required: true, message: '荫房记录只认值守填的那份，请填写值守人' }]}
          >
            <Input placeholder="如：赵荫" style={{ maxWidth: 240 }} />
          </Form.Item>
          <Typography.Text strong>入出房与温湿度条次</Typography.Text>
          <Form.List name="entries">
            {(fields, { add, remove }) => (
              <Space direction="vertical" size={10} style={{ display: 'flex', marginTop: 8 }}>
                {fields.map((field) => {
                  const values = (form.getFieldValue(['entries', field.name]) ?? {}) as Partial<EntryFormItem>;
                  const verdict = judgeVerdict(values.tempC ?? 24, values.humidityPct ?? 75);
                  return (
                    <Card
                      key={field.key}
                      size="small"
                      styles={{ body: { padding: 12 } }}
                      title={
                        <Space size={8}>
                          <TabletOutlined />
                          <span>第 {field.name + 1} 条</span>
                          <Tag color={ROOM_VERDICT_COLOR[verdict]}>
                            平板判定：{ROOM_VERDICT_LABEL[verdict]}
                          </Tag>
                        </Space>
                      }
                      extra={
                        fields.length > 1 ? (
                          <Button size="small" type="link" danger onClick={() => remove(field.name)}>
                            移除
                          </Button>
                        ) : null
                      }
                    >
                      <Row gutter={10}>
                        <Col xs={24} sm={9}>
                          <Form.Item
                            name={[field.name, 'bodyRef']}
                            label="胎体编号 / id"
                            rules={[{ required: true, message: '可填编号，匹配不上会挂待认领' }]}
                            style={{ marginBottom: 8 }}
                          >
                            <AutoComplete options={bodyOptions} placeholder="如 LQ-2401" allowClear />
                          </Form.Item>
                        </Col>
                        <Col xs={12} sm={5}>
                          <Form.Item name={[field.name, 'date']} label="日期" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <Input type="date" />
                          </Form.Item>
                        </Col>
                        <Col xs={6} sm={5}>
                          <Form.Item name={[field.name, 'inAt']} label="入房" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <Input type="time" />
                          </Form.Item>
                        </Col>
                        <Col xs={6} sm={5}>
                          <Form.Item name={[field.name, 'outAt']} label="出房" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <Input type="time" />
                          </Form.Item>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Form.Item name={[field.name, 'tempC']} label="温度℃" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <InputNumber min={5} max={45} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col xs={12} sm={6}>
                          <Form.Item name={[field.name, 'humidityPct']} label="湿度%" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <InputNumber min={10} max={100} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Card>
                  );
                })}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ ...DEFAULT_ENTRY })}>
                  加一条入出房记录
                </Button>
              </Space>
            )}
          </Form.List>
        </Form>
      </Modal>

      {/* 合并预演确认 */}
      <Modal
        open={planBatch !== null}
        title={
          simulate
            ? `演练中途失败：${planBatch?.code ?? ''}`
            : `合并入档案：${planBatch?.code ?? ''}`
        }
        okText={simulate ? '提交并触发回滚演练' : '确认合并'}
        cancelText="取消"
        okButtonProps={{ danger: simulate }}
        onCancel={closePlan}
        onOk={() => void confirmMerge()}
      >
        {planBatch && activePlan ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {simulate ? (
              <Alert
                type="warning"
                showIcon
                icon={<ThunderboltOutlined />}
                message="将在荫房记录与待复检回写之后、提交之前抛错"
                description="整个事务回滚：不会多出荫房记录、道次不变；批次留失败底，再送一次仍按条次幂等。"
              />
            ) : null}
            <Timeline
              items={[
                {
                  color: 'green',
                  children: `并入荫房记录 ${activePlan.toMerge.length} 条（温湿度与出入房时间原样，判定按档案规则复判，值守原判留底）`,
                },
                {
                  color: activePlan.recheckBodyIds.length > 0 ? 'red' : 'gray',
                  children:
                    activePlan.recheckBodyIds.length > 0
                      ? `越界命中 ${activePlan.recheckBodyIds.length} 个胎体：只把没做完的道次挂待复检，已完成道次不动`
                      : '本批无越界条次，不回写待复检',
                },
                {
                  color: activePlan.duplicates.length > 0 ? 'blue' : 'gray',
                  children: `重复跳过 ${activePlan.duplicates.length} 条（档案中已有同一平板条次，不多出记录）`,
                },
                {
                  color: activePlan.unresolved.length > 0 ? 'red' : 'gray',
                  children: `待认领 ${activePlan.unresolved.length} 条（编号对不上，挂起不挡本批其他条次，可随后认领）`,
                },
                {
                  color: 'gray',
                  children: '道次快照仅留底比对，工序管理员在档案侧推进过的道次不会被平板旧道次覆盖。',
                },
              ]}
            />
            {activePlan.toMerge.length > 0 ? (
              <div>
                <Typography.Text strong>本次并入预览</Typography.Text>
                <Table<PlannedEntry>
                  rowKey={(item) => item.entry.entryId}
                  size="small"
                  pagination={false}
                  style={{ marginTop: 6 }}
                  dataSource={activePlan.toMerge}
                  columns={[
                    { title: '日期', dataIndex: ['entry', 'date'], width: 100 },
                    {
                      title: '胎体',
                      width: 110,
                      render: (_v, record) => record.body?.code ?? '—',
                    },
                    {
                      title: '温湿度',
                      width: 110,
                      render: (_v, record) => `${record.entry.tempC}℃ / ${record.entry.humidityPct}%`,
                    },
                    {
                      title: '复判',
                      width: 90,
                      render: (_v, record) => (
                        <Tag color={ROOM_VERDICT_COLOR[record.officialVerdict]}>
                          {ROOM_VERDICT_LABEL[record.officialVerdict]}
                        </Tag>
                      ),
                    },
                  ]}
                />
              </div>
            ) : null}
          </Space>
        ) : null}
      </Modal>

      {/* 待认领条次认领 */}
      <Modal
        open={claiming !== null}
        title={`认领条次：${claiming?.entry.date ?? ''}　${claiming?.entry.bodyRef ?? ''}`}
        okText="确认认领"
        cancelText="取消"
        onCancel={() => setClaiming(null)}
        onOk={() => void submitClaim()}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            icon={<ExclamationCircleOutlined />}
            message="认领只是把条次挂到真实胎体上，不立即写荫房记录"
            description="下次合并该批次时随批并入；已并好的其他条次不受影响。"
          />
          <Select
            style={{ width: '100%' }}
            showSearch
            placeholder="选择档案中的胎体"
            optionFilterProp="label"
            options={bodyIdOptions}
            value={claimBodyId}
            onChange={setClaimBodyId}
          />
          {claiming?.entry ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              条次内容：{claiming.entry.tempC}℃ / {claiming.entry.humidityPct}% ·{' '}
              {claiming.entry.inAt}–{claiming.entry.outAt} ·{' '}
              <CheckCircleOutlined /> {ROOM_VERDICT_LABEL[judgeVerdict(claiming.entry.tempC, claiming.entry.humidityPct)]}
            </Typography.Text>
          ) : null}
        </Space>
      </Modal>
    </div>
  );
}
