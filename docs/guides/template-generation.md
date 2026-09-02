# 项目模板生成

DexCode 当前保留项目模板生成器和 Runtime API，但 Web UI 没有模板选择入口。模板生成应通过 API 调用，或由 Agent 使用普通文件工具完成。

## 可用模板

| ID | 名称 | 类别 |
|---|---|---|
| `vite-react-ts` | Vite + React + TypeScript | frontend |
| `express-api` | Express API 服务 | backend |
| `next-app` | Next.js 应用 | fullstack |
| `spring-boot` | Spring Boot 应用 | backend |
| `react-app` | Create React App | frontend |

模板定义位于 `packages/template-generator/templates.ts`，生成逻辑位于 `packages/template-generator/index.ts`。

## 查询模板

```powershell
Invoke-RestMethod http://localhost:3000/api/templates
Invoke-RestMethod http://localhost:3000/api/templates/vite-react-ts
Invoke-RestMethod http://localhost:3000/api/templates/category/frontend
```

接口：

- `GET /api/templates`：返回模板摘要列表；
- `GET /api/templates/:id`：返回模板详情；
- `GET /api/templates/category/:category`：按类别过滤。

## 生成骨架

`POST /api/scaffold/generate` 返回 SSE。请求体支持：

```json
{
  "projectName": "sample-app",
  "templateId": "vite-react-ts",
  "author": "Team",
  "description": "Sample application"
}
```

PowerShell 示例：

```powershell
$body = @{
  projectName = 'sample-app'
  templateId = 'vite-react-ts'
  description = 'Sample application'
} | ConvertTo-Json

Invoke-WebRequest `
  -Uri http://localhost:3000/api/scaffold/generate `
  -Method Post `
  -ContentType 'application/json' `
  -Body $body
```

Runtime 会把模板中的文件逐个写入当前请求对应的工作区，并发送：

- 每个文件一条 `tool` 事件；
- 成功时一条包含 `scaffoldInfo` 和文件列表的 `result`；
- 失败时一条 `error`。

未提供参数时，默认项目名为 `my-project`，默认模板为 `vite-react-ts`。

## 扩展模板

新增模板时：

1. 在 `packages/template-generator/templates.ts` 增加唯一 ID 的 `TemplateDefinition`；
2. 使用工作区相对路径定义文件；
3. 只使用生成器支持的占位符；
4. 为查询、占位符替换和文件列表增加测试；
5. 更新本页的模板表。

模板 API 会直接调用 template service，不经过 Main Agent 或 AgentManager。
