# version-vector-set

离线复制用的**版本向量集合**。每个副本记录一个连续前缀（`head`）和若干**规范的离散缺口区间**（`gaps`），
因此乱序到达的事件不需要逐事件存储——内存规模只与**区间数量**相关，与最大计数器无关。

- 副本身份是**稳定的二进制 ID**（`Uint8Array` / hex），按无符号字节序确定排序。
- 计数器为任意精度 `bigint`（数字入参要求安全整数，线格式为十进制字符串），上限 `2^64 - 1`。
- 操作：`contains`、`add`、`merge`、`difference`，以及**可截断、可续传**的缺失请求。
- `difference` 用区间线性扫描，**绝不逐事件展开**：跨越 `10^18` 个计数器的缺口仍是一个区间。
- 序列化是**确定顺序**的 JSON；反序列化严格拒绝重叠、相邻、倒序和越界区间。

零运行时依赖。需要 Node.js >= 20。

## 安装与测试

```bash
npm install
npm test     # tsc 严格类型检查 + node:test（含差分测试与堆内存验证，使用 --expose-gc）
npm run build
```

## 快速上手

```ts
import {
  VersionVectorSet,
  ReplicaId,
  nextMissingRequest,
} from 'version-vector-set';

const replicaA = ReplicaId.fromHex('a1b2');
let v = VersionVectorSet.empty();

v = v.add(replicaA, 1n);
v = v.add(replicaA, 5n);   // 乱序：成为缺口区间里的一个点
v = v.add(replicaA, 2n);   // 桥接：head 推进，但 5 仍是离散点

v.contains(replicaA, 5n);  // true
v.head(replicaA);          // 2n
v.gapCount(replicaA);      // 1

// 与对端合并（满足结合律、交换律、幂等律）
const merged = local.merge(peerState);

// 结构差：本地有而对端没有的所有计数器（区间形式，不展开事件）
const diff = local.difference(peerState);

// 基于差生成“我缺什么”的有界请求页（字节预算截断，游标续传）
const page = nextMissingRequest(
  responder.difference(requester).entries(),
  4096,
  (id) => requester.head(id),
);
// page.want: [{ id, since, ranges: [["lo","hi"], ...] }]
// page.next 存在时，原样传回 nextMissingRequest 取下一页。
```

## 线格式（确定性 JSON）

```json
{"a1b2":{"p":"2","gaps":[["5","5"]]}}
```

- key：副本 ID 的小写 hex，按无符号字节序升序。
- `p`：连续前缀长度（计数器 `1..p` 全部已见），十进制字符串。
- `gaps`：`p` 之上的离散区间 `[lo, hi]`（两端含），严格升序、互不相交、**互不相邻**。
  空列表可省略。

`VersionVectorSet.parse` 严格校验并抛出 `VersionVectorError`（`code` 区分错误类别）：

| code | 触发条件 |
| --- | --- |
| `BAD_REPLICA_ID` | ID 非空字节序列 / hex 非法 |
| `BAD_COUNTER` / `COUNTER_UNSAFE` | 计数器非十进制、非安全整数、`< 1` |
| `COUNTER_OUT_OF_BOUNDS` | 超过 `2^64 - 1` |
| `RANGE_REVERSED` | `lo > hi` |
| `RANGE_OVERLAPS_PREFIX` | 区间起点 `<= p` |
| `RANGE_NOT_NORMALIZED` | 区间重叠、相邻或乱序 |
| `BAD_WIRE_FORMAT` | JSON 结构/字段非法、ID 未排序 |
| `BAD_CURSOR` | 续传游标被篡改或非法 |
| `BUDGET_TOO_SMALL` | 字节预算放不下哪怕一个区间 |

## 结构与复杂度

| 操作 | 复杂度 |
| --- | --- |
| `contains` | `O(log k)` |
| `add`（单点） | `O(k)`，桥接时折叠区间并推进 `head` |
| `merge` | `O(k1 + k2)` 区间归并 |
| `difference` | `O(k1 + k2)` 区间扫描，零事件展开 |
| 序列化 / 解析 | `O(k log k)`（按 ID 与区间排序） |

`k` 为该副本的缺口区间数。新增事件若落在连续段或已见区间内是幂等的；填补缺口后
相邻区间被规范化合并，连续段一旦闭合即把前缀推进到最远连续位置。

## 测试覆盖

- 重复事件、巨大缺口、一次桥接多个区间、不同添加顺序收敛到同一规范序列化。
- 三方合并（多种归并顺序结果一致）、双向 `difference`。
- 截断/续传缺失请求（严格字节预算、游标防篡改、预算过小报错）。
- 损坏输入：重叠、相邻、倒序、越界、非法 JSON、乱序 ID。
- 随机操作流与朴素逐事件 `Set` 模型差分对照（稠密/稀疏宇宙）。
- 大数值（`~2^60`）下区间并集/差集与独立区间参考实现对照。
- 堆内存：占用随区间数线性、与最大计数无关（`--expose-gc`）。
