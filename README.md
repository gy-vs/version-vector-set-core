# 离线复制的版本向量集合 (Version Vectors for Offline Replication)

一个结构化的“每个副本已见事件计数”集合，专为乱序到达、离线复制设计。
每个副本保存：

- **连续前缀 `prefix`**：`1..prefix` 全部已见；
- **离散区间 `segments`**：`prefix` 之上已见但尚未与前缀连通的有序、不重叠区间。

内存规模与**区间数量**相关，与最大计数无关——一个跨越 `2^64-1` 的缺口
仍然只占一个区间二元组。

副本 id 是**稳定二进制身份**（`Uint8Array`，按无符号字节序排序）；
计数器是 **`bigint`**，合法范围 `1..2^64-1`（`MAX_COUNTER`）。

## 能力

| API | 说明 |
| --- | --- |
| `add(id, n)` | 记录单个事件 |
| `addRange(id, lo, hi)` | 记录一个区间，规范化重叠/相邻区间 |
| `contains(id, n)` | 是否已见（对区间二分，`O(log segments)`） |
| `merge(other)` | 合并另一个向量或序列化文档，交换、结合 |
| `difference(other)` | 我有、对方没有的**结构**区间，绝不逐事件展开 |
| `diff.page(maxSpan, maxRequests, cursor?)` | 生成截断、可续传的缺失事件拉取请求 |
| `serialize()` / `encode()` | 确定顺序的 JSON（id 字节序，计数器十进制字符串） |
| `VersionVector.decode(x)` | 严格校验解码，拒绝损坏输入 |

## 关键语义

- **规范化**：新到达区间吸收所有与之重叠或相邻的已有区间；一旦桥接
  补齐缺口，连续前缀向前推进（可能连锁吞掉多个区间）。
- **difference**：输出仍是区间。`A` 有 `[1..MAX]`、`B` 有 `[1..10]`
  时，差异是单个区间 `[11..MAX]`，而不是 `2^64` 个条目。内部用双指针
  区间相减，同时扣除对方的前缀和离散段。
- **缺失请求分页**：`page(maxSpan, maxRequests, cursor)` 以规范顺序
  （id 升序、计数升序）产生 `{id, from, to}`，每请求至多 `maxSpan` 个
  计数，每次至多 `maxRequests` 个请求；返回不透明 base64url 游标以便
  断点续传，`cursor === null` 表示枚举完毕。页容量恰好在段边界用满时，
  会返回一次空页 + 边界游标的稳定续传协议。
- **序列化校验**（`VersionVectorError.code`）：
  - `bad-document`：结构/类型/未知字段错误；
  - `bad-id`：id 非字节、空或超长；
  - `bad-range`：计数越界（`<=0`、`>2^64-1`）、区间倒序；
  - `overlap`：区间重叠、早于前一区间、重复 id、id 未排序；
  - `bad-cursor`：续传令牌损坏。
  - **相邻区间不是错误**：解码时会被规范化（合并、或折入前缀），保证
    往返后的文档保持唯一规范形；重叠/倒序才拒绝。

## 用法

```ts
import { VersionVector, MAX_COUNTER } from "./dist/src/index.js";

const A = new Uint8Array([0xaa]);

const v = new VersionVector();
v.add(A, 12n);                 // 乱序：先收到 12
v.addRange(A, 1n, 10n);        // prefix=10, segments=[12..12]
v.add(A, 11n);                 // 桥接 -> prefix=12, segments=[]
v.add(A, MAX_COUNTER);         // 巨型缺口仍是一个区间

v.contains(A, MAX_COUNTER);    // true

const diff = v.difference(peer);
const { requests, cursor } = diff.page(1000n, 100); // 拉取请求
const wire = v.serialize();    // 确定顺序 JSON
const back = VersionVector.decode(wire);
```

## 测试与模糊对照

```bash
npm test     # 编译 + node:test（含规模计时与损坏输入用例）
npm run fuzz # 四个差分模糊测试，对照朴素逐事件 Set 模型
```

模糊测试使用确定性 PRNG（可复现种子），在随机 `add/addRange/merge`
（含文档分支）序列下：

1. 与朴素 `Set<id:n>` 模型逐项核对 `contains`、前缀、三方合并；
2. 核对两两 `difference` 完全一致（无幻影、无遗漏）；
3. 每次操作后检查区间不变量（有序、不重叠、与前缀留真实缺口）和
   序列化往返字节稳定；
4. 规模测试验证 2000 个接近 `2^64` 的区间与 2000 个小区间序列化大小
   仅差常数量级，`contains` 保持对数，difference/merge 不随缺口放大而
   变慢（断言计时上限）。

覆盖的场景包括：重复事件、巨大缺口、单次桥接多个区间、不同添加顺序
收敛、三方合并的不同拓扑、截断/续传缺失请求、以及各类损坏输入。

## 布局

```
src/errors.ts   类型化错误、计数器/id 校验、二进制比较
src/vector.ts   VersionVector：前缀+区间、addRange 规范化、merge、decode
src/diff.ts     VectorDiff：结构差异与可续传分页请求
test/           node:test 用例（core / serialization / random / scale）
scripts/        差分模糊测试（朴素集合对照）
```
