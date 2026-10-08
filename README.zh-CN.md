# chopin-rsi

[English](README.md)

Chopin 是一个 RSI（recursive self-improvement，递归自我改进）执行器，建立在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）之上。
它推进一个长期工程，同时改进自己；改进受门禁约束，门禁只认工具调用日志。

agent loop、会话、界面、skill 和模型接入来自 dsh。Chopin 补上的是：

- **门禁**：会话日志里没有成功的工具调用，提交就被拒。
- **档案**：结论跨会话保存，按精确匹配检索，只在你批准后写入。
- **进化**：chopin 改自己只能落成仓库文件，并且必须通过自己的检查。
- **只写配置**：接入一个项目只写 YAML。

被拒的提交长这样：

```
Rejected by 1 unmet investigation gate(s):
- recurrence-ledger: Search the defect ledger first. Recurring N times means the previous
  N-1 fixes were at the wrong layer, which changes what counts as a root cause here.
Satisfy them with real tool calls. Only the tool-call log counts; stating that you already
did this does not.
```

## 安装

需要 Node 22.19+ 或 24，pnpm 12。chopin 为自己生成的可执行代码只在 macOS 上运行。

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm exec chopin install   # 准备 dsh 运行配置
pnpm exec chopin           # 终端界面；`chopin web` 打开网页界面
```

在 `~/.dsh/.env` 里写 `ANTHROPIC_API_KEY`，或在界面里用 `/login`；用什么凭证，就受对应服务商的条款约束。
一律从 `chopin` 启动，恢复会话也用 `chopin --session <id>`：只有它会带上代理和预加载。`/mode ultra`
给当前会话加上并行 worker。

安装时会关掉内置记忆插件的使用统计。在界面里提交反馈会把那段会话上传到 dsh 的收集服务；设置
`DSH_TELEMETRY_DISABLED=1` 可以一并关掉。

### 配置

可选，写在 `~/.dsh/.env`：

| 变量 | 含义 |
|---|---|
| `CHOPIN_REPO_PATH` | 要处理的项目（默认：当前目录） |
| `CHOPIN_TEST_COMMAND`、`CHOPIN_BUILD_COMMAND`、`CHOPIN_LINT_COMMAND` | 项目自己的检查命令（默认：pnpm 脚本） |
| `CHOPIN_LEDGER_DIR` | 已批准结论的存放处（默认 `~/.chopin/ledger`） |
| `CHOPIN_GITHUB_REPO` | issue 历史用的 `owner/repo` |
| `CHOPIN_SOURCES_FILE` | 要轮询的信号源（模板见 `examples/sources.example.yaml`） |
| `CHOPIN_LLM_PROXY` | 模型端点的代理 |
| `CHOPIN_USER_INSTRUCTIONS` | 你的规则文件，JSON 数组（默认 `~/.claude/CLAUDE.md`，存在才读） |
| `CHOPIN_CLAUDE_SKILLS_DIR` | 额外的 skill 目录（默认 `~/.claude/skills`） |
| `CHOPIN_HMR=1` | 开发 chopin 时热重载 |

## 接入一个项目

项目常量就是上面的环境变量。信号源（issue、日志、错误监控）写在 `CHOPIN_SOURCES_FILE` 指向的文件里。
命令写成 `toolsets/` 下的 YAML，并在 preset 的 `chopin-toolset` 一行里按名字启用。手写的 playbook 放在
`~/.agents/skills/`，原样使用。

```yaml
- name: repo_show_at_tag
  description: Show a file as it was at a release tag.
  command: git -C ${REPO_PATH} show {{tag}}:{{path}}
  params:
    tag: { description: the release tag }
    path: { description: repo-relative file path }
  outputBudgetBytes: 32768
```

`${VAR}` 是配置常量。`{{param}}` 是模型填的入参，按单引号转义；以 `-` 开头的值会被拒绝，除非标了
`allowLeadingDash: true`。前置检查不过的整组工具不注册，并在日志里点名。

## 加一个 mission

一个 mission 就是 preset 里的一行 `@chopin/report`：产出 schema 和门禁写在一起。

```yaml
- id: chopin-report-root-cause
  name: '@chopin/report'
  config:
    tool:
      name: submit_root_cause_report
      description: File the finished analysis.
      parameters: { type: object, required: [problem, rootCause], properties: { ... } }
    gates:
      - id: recurrence-ledger
        description: Search the defect ledger first.
        satisfiedByTools: [ledger_search]
```

写完跑 `pnpm check:composition`：门禁点名的工具没有插件提供时，它会报错。

## chopin 怎么进化

经验从 MemOS 的对话事实，到待定区的候选，再到你批准过的档案；反复出现的经验会变成一条 toolset 或门禁规则。
`submit_evolution` 要求先查运行时契约、在临时运行配置里挂起整套组合、跑 chopin 的测试并检查完整 diff。
生成的可执行代码在沙箱里运行，需要你批准，先灰度再上线。门禁的改动永远不自动生效；已部署的能力失败多于
成功会被隔离。

## 无人值守

`chopin service` 生成 launchd plist（装不装由你），回合在瞬时故障后自动续跑，`ralph` 跑长任务，
`schedule_*` 工具按时执行。进化只在你在场时发生。

## 开发

```bash
pnpm typecheck            # 包与测试的类型检查
pnpm test                 # 单元测试
pnpm test:e2e             # 真实 dsh 组合
pnpm check:composition    # 每一行都装得出来，每条门禁都点名真实工具
pnpm smoke:composition    # 在临时运行配置里挂一遍整套组合
```

架构与约定见 `CLAUDE.md`。

## 协议

Apache-2.0。内置的 `grilling`、`grill-me` 两个 skill 保留各自的 MIT 协议。
