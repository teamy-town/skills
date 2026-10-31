# 900：通用 artifact 评论工具交接

实现与最终测试候选：`8fb869b79ce22e71b45fa1a8d0777fe22cf0fdec`。
起点：`2cad15c29e3def8de4e7473efda36c98e18fdbe0`，已包含 #894 设计工具。
后续证据提交仅保存本目录，不改变产品代码或测试；`source-manifest.json`
记录交付文件 SHA-256。本报告是开发者自测，供独立 QA 和技术审查使用。

## 行为与验收

既有 `artifact` 技能新增四个工具，任何声明该技能的 agent 均可使用：

| 工具 | 行为 |
| --- | --- |
| `artifact_comments` | 返回一页根评论及真实 `nextCursor`；保留原版本、revision、anchor、完整正文、作者、解决状态、回复数与投递事实。 |
| `artifact_comment_replies` | 按显式 artifact id / 原根评论 id 分页读线程回复；根列表与回复分别分页。 |
| `artifact_comment_reply` | 回复指定线程，可带已确认设计写入 receipt 中的 `artifactId/revisionId/version`；同键同内容可幂等重试。 |
| `artifact_comment_resolve` | 必须明确传 `resolved:true/false` 解决或重开；工具说明限定为用户明确请求，已有项目评论权限成员均可请求，后端核权。 |

`src/artifactComments.ts` 是薄 HTTP 适配层：运行时请求/响应/query schema、
HTTP 操作和 routes 全从 `@zibby/artifact-contracts/comment` 导入，复用现有
会话、API URL 和有截止时间的 HTTP 门。工具 JSON 输入描述沿用既有设计工具约定。
不接收自报作者、账号、角色或平台密钥；显示名与正文 @ 不构成权限或回写定位。
未增加模板 pin、prompt、agent 分支、独立调度器或生产存储。

| 验收 | `src/__tests__/artifact-comments.test.ts` 中的证据 |
| --- | --- |
| AC1 | 用 #897 同源 `createCommentMock`、fixtures、schema/routes：显式跟随游标读完三个根评论及多页完整回复；三种 anchor 与原 revision 保持不变；定点回复、显式解决/重开，其他有评论权限成员也可操作。 |
| AC2 | 与 #892 `createDesignTransportMock` 组合：读 V1 评论 → 按原版本读三板 → 只改第二板得到 V2 → 复制已确认 receipt 回复原线程。其余两板、无关线程与原版不变；保存、普通回复、服务最终回答均不自动改解决状态。另验证当前版删板后仍可读原版 pin。 |
| AC3 | 同名无权用户和外部密码身份拒绝全部四种操作；伪造身份字段在共享 schema 校验失败；无效/跨线程 cursor、缺失线程、伪造/不存在/跨 artifact 版本引用保留具体原因。页面缺 `nextCursor` 或写入 receipt 不完整时不宣称成功。503 未启动、目标不可用及投递失败的原因也保留。 |
| AC4 | 既有 artifact、设计阶段1、preflight、描述、会话环境、通用 MCP、共享模块、HTTP 门回归全部通过。真实通用 MCP tools/list 和 tools/call 使用 third-party-agent 上下文发现并调用新增能力。 |

另覆盖 pending 尚无 execution、failed 与 answered 的真实投递事实，以及服务产生的
最终回复 receipt；最终回答回写由共享服务 mock 完成，skill 不猜目的地。

## 复现与查看效果

本次实际工作区（原生登记 worktree，无容器）：

`/Users/jcui/.zibby/work/selfhosted-project/100a934b-69fb-4b9c-b0f5-718e05e2fc56/89bbd46f-9ebb-4820-a182-fc0f1540e032`

在该目录，已准备好的依赖可直接复现工具状态与组合场景：

```sh
npm test -- src/__tests__/artifact-comments.test.ts --reporter=verbose
```

无需新服务、真实令牌或生产评论后端。测试的 fetch 层把共享 HTTP 契约转接到同源
comment/design mock；权限来自服务侧会话上下文。测试隔离真实 CLI 主目录。

干净工作区可复用仓库现有准备脚本：

```sh
node scripts/setup-artifact-tests.mjs <packages-tree> <agent-workflow-source> <scratch-deps>
node <packages-tree>/scripts/build.mjs
npm run build:types
npm run lint
npm test -- src/__tests__/artifact-comments.test.ts src/__tests__/artifact-design.test.ts src/__tests__/artifact.test.ts src/__tests__/artifact-preflight.test.ts src/__tests__/artifact-description.test.ts src/__tests__/backend-session-env-contract.test.ts src/__tests__/sharedMcpServer.test.ts src/__tests__/sharedSkillModules.test.ts src/__tests__/skills-http-doors-bounded.test.ts
```

依赖由既有脚本复制到 scratch 后构建，未修改原始源树或新建 Git 仓库。
本次 packages 源从准确提交导出 `artifact-contracts skill-ids core ui-memory scripts`：

- packages：`9c562b5d8ff3801c1373203173c584d4bb64bb56`。
- `artifact-contracts` 版本 `2.0.29`，Git tree `e913e6355849379a206e821c77cb5dabfcb368bf`。
- agent-workflow：`00eff2d6aa9a88a713729d7875977579e88806ae`，版本 `2.0.29`。
- Node `v22.23.4`、Vitest `4.1.12`、TypeScript `5.9.3`、ESLint `10.14.0`、esbuild `0.28.2`。
- 本次未分配容器、镜像或 application environment；没有发布 environment definition。

## 检查结果及限制

`checks.json` 保存每条检查的完整命令、准确提交、耗时、退出码与日志：
日志仅规范化尾部空白以通过 `git diff --check`，检查输出内容未改动。

- `final-focused.txt`：**9 个 suite / 263 项通过**，含新增 **32 项** 评论测试。
- `final-before-comments.txt`：把最终评论测试单文件复制到准确起点的 `git archive`
  导出目录，只链接依赖，不替换产品代码，**32 项全部失败**。
- `candidate-build.txt`：共享构建脚本 **73 个入口成功构建**。测量提交
  `43c1181abaff7083ad1af4f00ce48ff7af7c5155` 与最终候选产品代码完全相同；
  后续仅修正工具清单断言、隔离测试会话和增加最终回答状态断言。
- `candidate-types.txt` / `before-types.txt`：全仓类型检查均 exit 2，
  **14 条完全相同的 TS2339**，全部在未改动 `src/datasetStore.ts`；无改动文件诊断。
- `candidate-lint.txt` / `before-lint.txt`：全仓 lint 均 exit 1，路径归一化后输出相同：
  未改动 `src/lib/repo-access.js:233–234` 的 **2 条 no-useless-assignment 错误**，
  另有 **22 条已有警告**。既有 ESLint 配置覆盖 JS/MJS，不 lint TS。
- `focused.txt` 记录首次回归唯一失败：旧工具清单断言未列新工具；已同步明确清单，
  `release-focused.txt` 与 `final-focused.txt` 分别记录修正后通过及最终通过。
- `git diff 2cad15c29e3def8de4e7473efda36c98e18fdbe0 --check` 通过；
  最后证据提交后的分支状态另由平台检查记录。

mock 只证明工具和共享契约调用，不证明生产评论后端、真实投递服务或权限存储。
本票未提供这些服务，不等待或获取外部生产依赖。没有新 UI、浏览器或截图验收。
尚需独立 QA 和技术审查；未合入本地主线、推送、发布、部署或重启。

## 规则、资料和选择

遵循完整根 AGENTS.md / CLAUDE.md、ENGINEERING_STANDARDS.md，以及
repos-and-identities SKILL.md；未发现更近规则文件。KB 查询仅返回旧凭据讨论，
没有可改变本实现的评论惯例；ticket/file/base 图谱读取未发现冲突。保留 #894 的
确认 commit 与独立 readBack 语义，并遵循团队已验证的 delivery/execution/服务 seq
身份事实。本次观察未与 fleet ledger 矛盾。

共享 HTTP 契约没有额外“完整线程”端点，因此采用根评论列表加线程回复页，说明
两者分别按 cursor 继续读取，不另造端点或本地全量组装。resolve/reopen 使用同一工具
的必填布尔参数，状态变化只有这条明确调用产生。增加的限制仅是共享协议已有结构
校验与后端安全边界，没有减少 agent 的既有能力，也没有代码解析自由文本作判断。
