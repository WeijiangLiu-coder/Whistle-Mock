# whistle.mock-console

Whistle 插件：按 `testHub_prod_2773` 用例树选择**叶子 mock 目录**，一键把该目录下全部接口写入 Values / Rules。

## 交互模型

1. 左侧按本地仓库完整目录展示（含 `base-data` 等），按需展开
2. **只有三端用例文件夹内的最小用例目录可勾选**；`base-data` 等仅浏览
3. 右侧预览该用例下所有接口将生成的规则，例如：

```text
/^(http|https)://.+?/getOrderDetailV1/ file://{getOrderDetailV1__3.门票订单详情页基础数据-预定成功.json}
```

4. 点击「应用到 Whistle」：
   - 解析每个 `.mock.ts` 引用的 `base-data/**.json`
   - 写入 Values
   - 在规则组（默认 `PC 订单`）里注释旧的同接口规则，并追加本用例全套规则

## 安装（插件）

```bash
cd /Users/weijiangliu/Desktop/code/mycode/whistleMock
npm install --registry=https://registry.npmjs.org/
npm run plugin:link
```

打开：

- Whistle → Plugins → `mock-console`
- 或 Tools → Mock
- 或 http://127.0.0.1:8899/whistle.mock-console/

## 配置

[`config.json`](./config.json)：

| 字段 | 说明 |
|------|------|
| `gitlabProjectKey` | 默认 `2773`，自动在 `~/my-gitlab` 下匹配仓库名 |
| `projectRoot` | 可选；一般不配，默认扫 `~/my-gitlab/*2773*` |
| `caseRoots` | 三端用例根目录名 |
| `ruleGroup` | 写入的 Whistle 规则组 |
| `whistlePort` | 默认 8899 |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cases/tree` | 用例树 |
| GET | `/api/cases/detail?path=` | 叶子用例详情 |
| POST | `/api/cases/apply` | `{ "path": "Ctrip.../xxx" }` 批量应用 |
