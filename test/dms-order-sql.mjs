// 工单内容详情（/dms/order/sql）的按类型路由 + argv 白名单 + 分页拼接测试。
//
// TABLE_SYNC → GetStructSyncExecSqlDetail（ExecSql 按语句分页：实测翻到末页
// 返回「没有可执行的脚本」占位行，宿主按 PageSize 顺序翻页直到拼满
// TotalSqlCount 或遇空页）；DC_* 数据变更同族 → GetDataCorrectOrderDetail
// （实测正文在 OrderDetail，不在 ConfigDetail；ATTACHMENT 时正文在附件里）；
// DATA_EXPORT → GetDataExportOrderDetail.OrderDetail.ExeSQL；DB_EXPORT /
// DATA_TRACK / DATA_ARCHIVE 没有 SQL，回报 facts；PERM_APPLY / OWNER_APPLY →
// GetPermApplyOrderDetail / GetOwnerApplyOrderDetail（也没有 SQL）；
// NDDL → ListDDLPublishRecords（结构设计的发布记录里带 DDL 脚本）。
// 全部用 mock runner 驱动 index.js 里 re-export 的 loadDmsOrderSql 真实代码
// 路径，不依赖本机 CLI。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadDmsOrderSql, classifyDmsError } from '../index.js'

function makeRunner(handler) {
  const calls = []
  return {
    calls,
    async tryRun(exe, argv) {
      calls.push({ exe, argv })
      return { out: handler(exe, argv), errText: '', code: 0 }
    },
  }
}

function argvGet(argv, key) {
  const i = argv.indexOf(key)
  return i >= 0 ? argv[i + 1] : null
}

test('TABLE_SYNC: 单页脚本（TotalSqlCount=1）一次调用返回全文', async () => {
  const script = 'create table `t1` (id bigint primary key);\n'
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    StructSyncExecSqlDetail: { ExecSql: script, TotalSqlCount: 1 },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '28003457', region: 'cn-hangzhou', tid: '123', type: 'TABLE_SYNC' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'TABLE_SYNC')
  assert.equal(res.sql, script.trim())
  assert.equal(res.sqlCount, 1)
  assert.equal(res.truncated, false)
  assert.equal(r.calls.length, 1)
  const { exe, argv } = r.calls[0]
  assert.equal(exe, 'aliyun')
  assert.deepEqual(argv, [
    'dms-enterprise', '--RegionId', 'cn-hangzhou', '--Tid', '123',
    'GetStructSyncExecSqlDetail', '--OrderId', '28003457',
    '--PageNumber', '1', '--PageSize', '50',
  ])
})

test('TABLE_SYNC: 多页脚本按 PageSize 翻页拼接，拼满 TotalSqlCount 即停', async () => {
  const stmts = Array.from({ length: 120 }, (_, i) => 'create table `t' + i + '` (id bigint);')
  const r = makeRunner((exe, argv) => {
    const no = Number(argvGet(argv, '--PageNumber'))
    const size = Number(argvGet(argv, '--PageSize'))
    const page = stmts.slice((no - 1) * size, no * size)
    return JSON.stringify({
      Success: true,
      StructSyncExecSqlDetail: { ExecSql: page.join('\n') + '\n', TotalSqlCount: stmts.length },
    })
  })
  const res = await loadDmsOrderSql(null, r, { id: '1', type: 'TABLE_SYNC' })
  // 页与页之间以换行衔接（各页自带尾换行，可能产生空行）
  assert.equal(res.sql.split('\n').filter((l) => l.trim()).length, 120)
  assert.ok(res.sql.includes('`t0`') && res.sql.includes('`t119`'))
  assert.equal(res.sqlCount, 120)
  assert.equal(res.truncated, false)
  // 120 条 / 每页 50 → 3 页（1*50<120、2*50<120、3*50>=120 停）
  assert.equal(r.calls.length, 3)
  assert.equal(argvGet(r.calls[0].argv, '--PageNumber'), '1')
  assert.equal(argvGet(r.calls[2].argv, '--PageNumber'), '3')
})

test('TABLE_SYNC: 空脚本（没有可执行的脚本占位行）→ sql 为 null', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    StructSyncExecSqlDetail: { ExecSql: '\n------ 没有可执行的脚本 ------\n', TotalSqlCount: 0 },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '2', type: 'TABLE_SYNC' })
  assert.equal(res.sql, null)
  assert.equal(res.sqlCount, 0)
  assert.equal(r.calls.length, 1)
})

test('TABLE_SYNC: 达到页数上限仍未拉全 → truncated 标记', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    StructSyncExecSqlDetail: { ExecSql: 'select 1;\n', TotalSqlCount: 99999 },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '3', type: 'TABLE_SYNC' })
  assert.equal(res.truncated, true)
  assert.equal(r.calls.length, 10) // SQL_SYNC_MAX_PAGES
})

// GetDataCorrectOrderDetail 形状：正文在 OrderDetail，ConfigDetail 只有
// DetailType 等子类型配置，库信息在 DatabaseList。
test('DC_COMMON: OrderDetail.ExeSQL 是正文（不是 ConfigDetail），facts 带类型/库/影响行数', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataCorrectOrderDetail: {
      ConfigDetail: { Cron: false, CurrentTaskId: 23364932, DetailType: 'COMMON' },
      DatabaseList: {
        Database: [{
          DbId: 69684552, DbType: 'mysql', EnvType: 'product', Logic: false,
          SearchName: 'test_db@10.0.0.1:3306 [databaseproxy_1]',
        }],
      },
      ExecMode: 'COMMITOR',
      OrderDetail: {
        ActualAffectRows: 1, Classify: 'require_deal_without_backend_function', EstimateAffectRows: 1,
        ExeSQL: "\nINSERT INTO t_demo(name, code)\nVALUES ('demo', 'DEMO_CODE');",
        RbSQLType: 'TEXT', SqlType: 'TEXT',
      },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '3', region: 'cn-hangzhou', type: 'DC_COMMON' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'DC_COMMON')
  assert.ok(res.sql.includes('INSERT INTO t_demo'))
  assert.equal(res.rollbackSql, null)
  assert.equal(res.attachmentName, null)
  assert.deepEqual(res.facts, [
    { k: '变更类型', v: '普通数据变更' },
    { k: '数据库', v: 'test_db@10.0.0.1:3306 [databaseproxy_1]（MYSQL · 生产）' },
    { k: '影响行数', v: '预估 1 行，实际 1 行' },
  ])
  assert.deepEqual(r.calls[0].argv, [
    'dms-enterprise', '--RegionId', 'cn-hangzhou',
    'GetDataCorrectOrderDetail', '--OrderId', '3',
  ])
})

// DC_* 同族（无锁 / 清理 / 导入 / 可编程对象）共用同一个 API，PluginType 原样回传。
test('DC_CHUNK / DC_CRON_CLEAR / DC_PROC: 同族都走 GetDataCorrectOrderDetail', async () => {
  const cases = [
    ['DC_CHUNK', 'CHUNK_DML', '无锁变更'],
    ['DC_CRON_CLEAR', 'CRON_CLEAR_DATA', '历史数据清理'],
    ['DC_PROC', 'PROCEDURE', '可编程对象变更'],
    ['DATA_CHANGE', 'COMMON', '普通数据变更'],
  ]
  for (const [type, detailType, label] of cases) {
    const r = makeRunner(() => JSON.stringify({
      Success: true,
      DataCorrectOrderDetail: {
        ConfigDetail: { DetailType: detailType },
        OrderDetail: { SqlType: 'TEXT', ExeSQL: 'select 1;', RbSQLType: 'TEXT', RbSQL: 'empty' },
      },
    }))
    const res = await loadDmsOrderSql(null, r, { id: '11', type })
    assert.equal(res.type, type)
    assert.equal(res.sql, 'select 1;')
    assert.equal(res.facts[0].v, label)
    assert.ok(r.calls[0].argv.includes('GetDataCorrectOrderDetail'))
  }
})

test('DC_CRON_CLEAR: DetailType=CRON_CLEAR_DATA 带 Cron 表达式 fact', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataCorrectOrderDetail: {
      ConfigDetail: { Cron: true, CronFormat: '0 0 3 3 * ?', CronCallTimes: 10, DetailType: 'CRON_CLEAR_DATA' },
      OrderDetail: { SqlType: 'TEXT', ExeSQL: 'delete from t1 where gmt_create < now();' },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '22250832', type: 'DC_CRON_CLEAR' })
  assert.equal(res.facts[0].v, '历史数据清理')
  assert.ok(res.facts.some((f) => f.k === '调度' && f.v === '0 0 3 3 * ?'))
})

test('DC_BIG_FILE: SqlType=ATTACHMENT → 正文为空并带附件名；回滚 SQL 保留', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataCorrectOrderDetail: {
      ConfigDetail: { DetailType: 'BIG_FILE' },
      OrderDetail: {
        SqlType: 'ATTACHMENT', AttachmentName: 'big_file.sql',
        RbSQL: 'delete from t1 where id <= 100;', RbSQLType: 'TEXT',
      },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '5', type: 'DC_BIG_FILE' })
  assert.equal(res.sql, null)
  assert.equal(res.attachmentName, 'big_file.sql')
  assert.equal(res.rollbackSql, 'delete from t1 where id <= 100;')
})

// ── 导出 / 追踪 / 归档：没有 SQL 的类型回报 facts ───────────────────────────
// DATA_EXPORT 夹具形状。
test('DATA_EXPORT: OrderDetail.ExeSQL 是导出语句，facts 带库/原因/行数/状态', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataExportOrderDetail: {
      KeyInfo: { JobId: 356440589, JobStatus: 'EXPORT_SUCCESS', PreCheckId: 68934563 },
      OrderDetail: {
        ActualAffectRows: 201, Classify: '数据分析', DbId: 69684559, EnvType: 'product',
        Database: 'test_db@10.0.0.1:3306 [databaseproxy_1]cn-hangzhou 非单元化',
        ExeSQL: 'SELECT * from `t_demo`', IgnoreAffectRows: false, Logic: false,
      },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '2', type: 'DATA_EXPORT' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'DATA_EXPORT')
  assert.equal(res.sql, 'SELECT * from `t_demo`')
  assert.deepEqual(res.facts, [
    { k: '数据库', v: 'test_db@10.0.0.1:3306 [databaseproxy_1]cn-hangzhou 非单元化（生产）' },
    { k: '导出原因', v: '数据分析' },
    { k: '影响行数', v: '201 行' },
    { k: '导出状态', v: '导出成功' },
  ])
})

test('SQL_EXPORT 别名同样走 GetDataExportOrderDetail', async () => {
  const r = makeRunner(() => JSON.stringify({ Success: true, DataExportOrderDetail: { OrderDetail: { ExeSQL: 'select 1;' } } }))
  const res = await loadDmsOrderSql(null, r, { id: '12', type: 'SQL_EXPORT' })
  assert.equal(res.supported, true)
  assert.equal(res.sql, 'select 1;')
  assert.deepEqual(r.calls[0].argv, ['dms-enterprise', 'GetDataExportOrderDetail', '--OrderId', '12'])
})

test('DB_EXPORT: 无 SQL，facts 展示导出内容/格式/表/下载地址', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DatabaseExportOrderDetail: {
      Id: 13, SearchName: 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306', StatusDesc: '审批中',
      KeyInfo: {
        AuditDate: '2026-09-01 10:00:00',
        DbId: 7001,
        DownloadURL: 'https://dms.aliyun.com/export/shop_db.zip',
        Config: {
          DbName: 'shop_db', ExportContent: 'DATA_STRUCT', TargetOption: 'SQL',
          ExportTypes: ['SINGLE_TABLE'], SelectedTables: ['t_order', 't_item'],
        },
      },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '13', type: 'DB_EXPORT' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'DB_EXPORT')
  assert.equal(res.sql, null)
  assert.deepEqual(res.facts, [
    { k: '数据库', v: 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306' },
    { k: '导出内容', v: '数据和结构' },
    { k: '导出格式', v: 'SQL' },
    { k: '导出类型', v: 'SINGLE_TABLE' },
    { k: '表', v: 't_order、t_item' },
    { k: '下载地址', v: 'https://dms.aliyun.com/export/shop_db.zip' },
  ])
  assert.deepEqual(r.calls[0].argv, ['dms-enterprise', 'GetDatabaseExportOrderDetail', '--OrderId', '13'])
})

test('DATA_TRACK: 无 SQL，facts 展示追踪表/类型/区间/任务状态', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataTrackOrderDetail: {
      DatabaseSearchName: 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306', DbId: 7002, Logic: false,
      JobStartTime: '2026-09-01 00:00:00', JobEndTime: '2026-09-01 12:00:00',
      JobStatus: 'FILTER_SUCCESS', SchemaName: 'shop_db', TableNames: ['t_order'],
      TrackTypes: ['UPDATE', 'DELETE'], StatusDesc: '解析完成',
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '14', type: 'DATA_TRACK' })
  assert.equal(res.type, 'DATA_TRACK')
  assert.equal(res.sql, null)
  assert.deepEqual(res.facts, [
    { k: '数据库', v: 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306' },
    { k: '追踪表', v: 't_order' },
    { k: '追踪类型', v: '更新、删除' },
    { k: '追踪区间', v: '2026-09-01 00:00:00 ~ 2026-09-01 12:00:00' },
    { k: '任务状态', v: '解析 Binlog 完成' },
  ])
  assert.deepEqual(r.calls[0].argv, ['dms-enterprise', 'GetDataTrackOrderDetail', '--OrderId', '14'])
})

test('DATA_ARCHIVE: 无 SQL，facts 展示归档方式/源库/归档表（含过滤条件）', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DataArchiveOrderDetail: {
      Id: 15,
      PluginParam: {
        ArchiveMethod: 'INSERT', RunMethod: 'RUN', DbSchema: 'shop_db', Logic: false,
        TargetInstanceId: 'rm-target-01', OrderAfter: ['delete'],
        TableIncludes: [
          { TableName: 't_order', TableWhere: "gmt_create < '2023-05-14'" },
          { TableName: 't_item', TableWhere: '' },
        ],
      },
      PluginExtraData: { InstanceTotal: 2 },
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '15', type: 'DATA_ARCHIVE' })
  assert.equal(res.type, 'DATA_ARCHIVE')
  assert.equal(res.sql, null)
  assert.deepEqual(res.facts, [
    { k: '归档方式', v: 'INSERT' },
    { k: '运行方式', v: 'RUN' },
    { k: '源库', v: 'shop_db' },
    { k: '目标实例', v: 'rm-target-01' },
    { k: '归档表', v: "t_order（gmt_create < '2023-05-14'）、t_item" },
    { k: '后置行为', v: 'delete' },
    { k: '归档任务数', v: '2' },
  ])
  assert.deepEqual(r.calls[0].argv, ['dms-enterprise', 'GetDataArchiveOrderDetail', '--OrderId', '15'])
})

// ── NDDL 结构设计：发布记录（ListDDLPublishRecords）里带 DDL 脚本 ──────────
// 夹具取自真实响应（工单 28217053：channel_promote_allocate_record_temp 加列/主键）。
test('NDDL: 发布记录的 Scripts 是正文，facts 带变更表/风险等级/发布策略', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DDLPublishRecordList: [{
      AuditStatus: 'TO_AUDIT',
      AuditExpireTime: '2026-10-15 17:19:40',
      Comment: '',
      CreatorId: 2695250,
      Finality: false,
      PublishStatus: 'AUDIT',
      PublishTaskInfoList: [{
        DbId: 82499294,
        Logic: false,
        PlanTime: '2026-10-15 17:19:40',
        PublishJobList: [{
          ExecuteCount: 0,
          Scripts: "ALTER TABLE `channel_promote_allocate_record_temp`\n\tCOMMENT='渠道推广分配记录临时表',\n\tADD PRIMARY KEY (`id`);",
          StatusDesc: '分析完成',
          TableName: 'channel_promote_allocate_record_temp',
          TaskJobStatus: 'NONE',
        }],
        PublishStrategy: 'IMMEDIATELY',
        StatusDesc: '分析完成',
        TaskJobStatus: 'NONE',
      }],
      RiskLevel: 'LOW_RISK',
      StatusDesc: '安全规则判定需要审批，已提交流程',
      WorkflowInstanceId: '13458291',
    }],
  }))
  const res = await loadDmsOrderSql(null, r, { id: '28217053', region: 'cn-hangzhou', tid: '123', type: 'NDDL' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'NDDL')
  assert.ok(res.sql.includes('ALTER TABLE `channel_promote_allocate_record_temp`'))
  assert.deepEqual(res.facts, [
    { k: '变更表', v: 'channel_promote_allocate_record_temp' },
    { k: '风险等级', v: '低风险' },
    { k: '发布策略', v: '立即执行' },
  ])
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.calls[0].argv, [
    'dms-enterprise', '--RegionId', 'cn-hangzhou', '--Tid', '123',
    'ListDDLPublishRecords', '--OrderId', '28217053',
  ])
})

test('NDDL: 多条发布记录/多表脚本全部拼接（空脚本跳过），变更表去重', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    DDLPublishRecordList: [
      {
        RiskLevel: 'HIGH_RISK',
        PublishTaskInfoList: [{
          PublishJobList: [
            { TableName: 't_order', Scripts: 'alter table `t_order` add column a bigint;' },
            { TableName: 't_order', Scripts: 'alter table `t_order` add key k(a);' },
            { TableName: 't_item', Scripts: '' },
          ],
          PublishStrategy: 'REGULARLY',
        }],
      },
      {
        PublishTaskInfoList: [{
          PublishJobList: [{ TableName: 't_order', Scripts: '   ' }],
        }],
      },
    ],
  }))
  const res = await loadDmsOrderSql(null, r, { id: '21', type: 'NDDL' })
  assert.equal(res.sql, 'alter table `t_order` add column a bigint;\n\nalter table `t_order` add key k(a);')
  assert.deepEqual(res.facts, [
    { k: '变更表', v: 't_order、t_item' },
    { k: '风险等级', v: '高风险' },
    { k: '发布策略', v: '定时执行' },
  ])
})

test('NDDL: 没有发布记录 → sql 为 null，facts 为空数组', async () => {
  const r = makeRunner(() => JSON.stringify({ Success: true, DDLPublishRecordList: [] }))
  const res = await loadDmsOrderSql(null, r, { id: '22', type: 'NDDL' })
  assert.equal(res.supported, true)
  assert.equal(res.sql, null)
  assert.deepEqual(res.facts, [])
  assert.equal(r.calls.length, 1)
})

test('未覆盖的工单类型不发起 CLI 调用，返回 supported=false', async () => {
  const r = makeRunner(() => { throw new Error('should not be called') })
  const res = await loadDmsOrderSql(null, r, { id: '6', type: 'GENERATE' })
  assert.equal(res.ok, true)
  assert.equal(res.supported, false)
  assert.equal(res.type, 'GENERATE')
  assert.equal(res.sql, null)
  assert.equal(r.calls.length, 0)
})

// ── PERM_APPLY / OWNER_APPLY：没有 SQL，回报申请内容 ────────────────────────
// 夹具形状：列级查询权限申请，有效期 180 天。
test('PERM_APPLY: 列权限 → 申请内容（类型/权限/有效期/资源定位），sql 恒为 null', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    PermApplyOrderDetail: {
      ApplyType: 'COL',
      PermType: 1,
      Seconds: 15552000,
      Resources: [{
        ColumnInfo: { ColumnName: 'address', TableName: 't_order' },
        DatabaseInfo: {
          DbId: 69606495, DbType: 'mysql', EnvType: 'product', Logic: false,
          OwnerNickNames: ['alice'],
          SearchName: 'shop_db@rm-example12345678.mysql.rds.aliyuncs.com:3306 [主实例]',
        },
        InstanceInfo: {}, RowInfo: {}, RowValueInfo: {}, TableInfo: {},
      }],
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '1', region: 'cn-hangzhou', tid: '123', type: 'PERM_APPLY' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'PERM_APPLY')
  assert.equal(res.sql, null)
  assert.equal(res.apply.applyType, 'COL')
  assert.equal(res.apply.applyTypeLabel, '列权限')
  assert.equal(res.apply.permType, 1)
  assert.equal(res.apply.permTypeLabel, '查询')
  assert.equal(res.apply.seconds, 15552000)
  assert.equal(res.apply.durationLabel, '180 天')
  assert.equal(res.apply.resourceCount, 1)
  assert.equal(res.apply.resources[0].label,
    'shop_db@rm-example12345678.mysql.rds.aliyuncs.com:3306 [主实例] · t_order.address')
  assert.equal(res.apply.resources[0].meta, 'MYSQL · 生产')
  assert.equal(r.calls.length, 1)
  assert.deepEqual(r.calls[0].argv, [
    'dms-enterprise', '--RegionId', 'cn-hangzhou', '--Tid', '123',
    'GetPermApplyOrderDetail', '--OrderId', '1',
  ])
})

test('PERM_APPLY: 行权限带匹配值、逻辑库进 meta、Seconds=0 记长期', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    PermApplyOrderDetail: {
      ApplyType: 'ROW', PermType: 7, Seconds: 0,
      Resources: [{
        RowInfo: { ColumnName: 'id', TableName: 't_order', SchemaName: 'shop', MatchMode: 'EQ', Logic: true },
        RowValueInfo: { RowValue: '42' },
        DatabaseInfo: { DbType: 'polardb', EnvType: 'test' },
        InstanceInfo: {}, TableInfo: {}, ColumnInfo: {},
      }],
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '7', type: 'PERM_APPLY' })
  assert.equal(res.apply.applyTypeLabel, '行权限')
  assert.equal(res.apply.permTypeLabel, '查询、导出和变更')
  assert.equal(res.apply.durationLabel, '长期有效')
  assert.equal(res.apply.resources[0].label, 'shop · t_order.id = 42')
  assert.equal(res.apply.resources[0].meta, 'POLARDB · 测试 · 逻辑库')
})

test('PERM_APPLY: 实例权限用连接地址定位；字段缺失回 null 而不是 0', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    PermApplyOrderDetail: {
      ApplyType: 'INSTANT',
      Resources: [{ InstanceInfo: { Host: 'rm-abc.mysql.rds.aliyuncs.com', Port: 3306, EnvType: 'product' } }],
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '8', type: 'PERM_APPLY' })
  assert.equal(res.apply.applyTypeLabel, '实例权限')
  assert.equal(res.apply.permType, null)
  assert.equal(res.apply.permTypeLabel, null)
  assert.equal(res.apply.seconds, null)
  assert.equal(res.apply.durationLabel, null)
  assert.equal(res.apply.resources[0].label, 'rm-abc.mysql.rds.aliyuncs.com:3306')
  assert.equal(res.apply.resources[0].meta, '生产')
})

test('OWNER_APPLY: 表 Owner 申请 → 资源 + 原 Owner，无权限类型/有效期', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: true,
    OwnerApplyOrderDetail: {
      ApplyType: 'TABLE',
      Resources: [{
        Logic: false,
        TargetId: 88,
        ResourceDetail: {
          SearchName: 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306',
          TableName: 't_order',
          DbType: 'mysql',
          EnvType: 'product',
          OwnerNickNames: ['alice'],
        },
      }],
    },
  }))
  const res = await loadDmsOrderSql(null, r, { id: '9', region: 'cn-hangzhou', type: 'OWNER_APPLY' })
  assert.equal(res.supported, true)
  assert.equal(res.type, 'OWNER_APPLY')
  assert.equal(res.sql, null)
  assert.equal(res.apply.applyTypeLabel, '表 Owner')
  assert.equal(res.apply.permTypeLabel, null)
  assert.equal(res.apply.durationLabel, null)
  assert.equal(res.apply.resources[0].label, 'shop_db@rm-abc.mysql.rds.aliyuncs.com:3306 · t_order')
  assert.equal(res.apply.resources[0].meta, 'MYSQL · 生产')
  assert.deepEqual(r.calls[0].argv, [
    'dms-enterprise', '--RegionId', 'cn-hangzhou',
    'GetOwnerApplyOrderDetail', '--OrderId', '9',
  ])
})

test('PERM_APPLY: 接口未回资源明细时 resources 为空数组（客户端给空态）', async () => {
  const r = makeRunner(() => JSON.stringify({ Success: true, PermApplyOrderDetail: { ApplyType: 'DB', PermType: 2, Seconds: 86400 } }))
  const res = await loadDmsOrderSql(null, r, { id: '10', type: 'PERM_APPLY' })
  assert.equal(res.apply.resourceCount, 0)
  assert.deepEqual(res.apply.resources, [])
  assert.equal(res.apply.durationLabel, '1 天')
})

test('白名单校验：非法 id / region / tid 拒绝', async () => {
  await assert.rejects(
    () => loadDmsOrderSql(null, makeRunner(() => ''), { id: 'abc', type: 'TABLE_SYNC' }),
    /缺少有效的工单 ID/,
  )
  await assert.rejects(
    () => loadDmsOrderSql(null, makeRunner(() => ''), { id: '1', region: 'bad region;rm', type: 'TABLE_SYNC' }),
    /无效的 RegionId/,
  )
  await assert.rejects(
    () => loadDmsOrderSql(null, makeRunner(() => ''), { id: '1', tid: '12ab', type: 'TABLE_SYNC' }),
    /无效的租户 Tid/,
  )
})

test('SDK 错误（Success=false）→ 抛出并携带 ErrorMessage（ErrorCode）', async () => {
  const r = makeRunner(() => JSON.stringify({
    Success: false,
    ErrorCode: 'InvalidOrderId',
    ErrorMessage: '工单不存在',
  }))
  await assert.rejects(
    () => loadDmsOrderSql(null, r, { id: '999999999', type: 'TABLE_SYNC' }),
    (e) => /工单不存在/.test(String(e)) && /InvalidOrderId/.test(String(e)),
  )
})

test('classifyDmsError: OAuth 刷新令牌过期提示重登（复用 SLS 同款提示）', () => {
  const err = 'ERROR: init client failed: failed to refresh token, status code: 400, error: invalid_grant, ' +
    'description: Refresh token expired: test-refresh-token, ' +
    'requestId: test-request-id; ' +
    're-authenticate: aliyun configure --mode OAuth --oauth-site-type CN --profile OAuthProfile'
  const msg = classifyDmsError(new Error(err))
  assert.match(msg, /OAuth 登录已过期/)
  assert.match(msg, /重新运行 `aliyun configure --mode OAuth --oauth-site-type CN --profile OAuthProfile`/)
  // 与「无有效登录凭证」的 AccessKey 提示区分开
  assert.ok(!/AccessKey/.test(msg))
})

test('classifyDmsError: 无 re-authenticate 命令的过期错误也识别（通用重登提示）', () => {
  const msg = classifyDmsError(new Error('ERROR: init client failed: failed to refresh token, error: invalid_grant'))
  assert.match(msg, /OAuth 登录已过期/)
  assert.match(msg, /重新运行 `aliyun configure --mode OAuth --oauth-site-type CN`/)
})
