import type { TemplateDefinition } from "./types.ts";

export const templates: Record<string, TemplateDefinition> = {
  "vite-react-ts": {
    id: "vite-react-ts",
    name: "Vite + React + TypeScript",
    description:
      "使用 Vite 构建的现代化 React 项目，包含 TypeScript 支持、热更新和优化的构建体验",
    category: "frontend",
    language: "typescript",
    framework: "React",
    version: "18.0",
    files: [
      {
        path: "package.json",
        content: `{
  "name": "{{projectName}}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitejs/plugin-react": "^4.2.1",
    "eslint": "^8.55.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "eslint-plugin-react-refresh": "^0.4.5",
    "typescript": "^5.2.2",
    "vite": "^5.0.8"
  }
}`,
      },
      {
        path: "index.html",
        content: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
      },
      {
        path: "vite.config.ts",
        content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})`,
      },
      {
        path: "tsconfig.json",
        content: `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "moduleResolution": "bundler"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}`,
      },
      {
        path: "tsconfig.node.json",
        content: `{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}`,
      },
      {
        path: "src/main.tsx",
        content: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`,
      },
      {
        path: "src/App.tsx",
        content: `import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <div>
        <h1>{{projectName}}</h1>
        <p>欢迎使用 Vite + React 项目模板</p>
      </div>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          点击数: {count}
        </button>
        <p>
          编辑 <code>src/App.tsx</code> 并保存即可热更新
        </p>
      </div>
    </>
  )
}

export default App`,
      },
      {
        path: "src/index.css",
        content: `:root {
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
}

a {
  font-weight: 500;
  color: #646cff;
  text-decoration: inherit;
}
a:hover {
  color: #535bf2;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  cursor: pointer;
  transition: border-color 0.25s;
}
button:hover {
  border-color: #646cff;
}
button:focus,
button:focus-visible {
  outline: 4px auto -webkit-focus-ring-color;
}

@media (prefers-color-scheme: light) {
  :root {
    color: #213547;
    background-color: #ffffff;
  }
  a:hover {
    color: #747bff;
  }
  button {
    background-color: #f9f9f9;
  }
}`,
      },
      {
        path: "src/App.css",
        content: `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.react:hover {
  filter: drop-shadow(0 0 2em #61dafbaa);
}

@keyframes logo-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: no-preference) {
  a:nth-of-type(2) .logo {
    animation: logo-spin infinite 20s linear;
  }
}

.card {
  padding: 2em;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  cursor: pointer;
  transition: border-color 0.25s;
}
button:hover {
  border-color: #646cff;
}
button:focus,
button:focus-visible {
  outline: 4px auto -webkit-focus-ring-color;
}`,
      },
      {
        path: ".gitignore",
        content: `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?`,
      },
      {
        path: ".eslintrc.cjs",
        content: `module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}`,
      },
      {
        path: "README.md",
        content: `# {{projectName}}

这是一个使用 Vite + React + TypeScript 构建的现代化前端项目。

## 快速开始

### 安装依赖
\`\`\`bash
npm install
\`\`\`

### 开发模式
\`\`\`bash
npm run dev
\`\`\`

### 生产构建
\`\`\`bash
npm run build
\`\`\`

### 预览生产构建
\`\`\`bash
npm run preview
\`\`\`

## 项目结构

\`\`\`
src/
├── App.tsx          # 主应用组件
├── App.css          # 应用样式
├── main.tsx         # 应用入口
└── index.css        # 全局样式
\`\`\`

## 技术栈

- Vite 5.0+
- React 18.0+
- TypeScript 5.2+
- ESLint

## 开发建议

1. 使用 TypeScript 编写类型安全的代码
2. 遵循 ESLint 规则
3. 充分利用 Vite 的热更新功能进行快速开发
4. 定期进行代码检查和优化

## License

MIT`,
      },
    ],
  },

  "express-api": {
    id: "express-api",
    name: "Express API 服务",
    description:
      "快速创建 Node.js Express REST API 服务，包含路由、中间件和错误处理",
    category: "backend",
    language: "typescript",
    framework: "Express",
    version: "4.18",
    files: [
      {
        path: "package.json",
        content: `{
  "name": "{{projectName}}",
  "version": "1.0.0",
  "description": "{{projectName}} - Express API 服务",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src --ext ts"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.6",
    "@typescript-eslint/eslint-plugin": "^6.17.0",
    "@typescript-eslint/parser": "^6.17.0",
    "eslint": "^8.56.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}`,
      },
      {
        path: "tsconfig.json",
        content: `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules"]
}`,
      },
      {
        path: "src/index.ts",
        content: `import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes/index.ts';
import { errorHandler } from './middleware/errorHandler.ts';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志中间件
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(\`[\${new Date().toISOString()}] \${req.method} \${req.path}\`);
  next();
});

// 健康检查端点
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API 路由
app.use('/api', router);

// 错误处理
app.use(errorHandler);

// 启动服务器
app.listen(port, () => {
  console.log(\`🚀 服务器运行在 http://localhost:\${port}\`);
});`,
      },
      {
        path: "src/routes/index.ts",
        content: `import { Router, Request, Response } from 'express';

export const router = Router();

// 示例路由
router.get('/hello', (req: Request, res: Response) => {
  res.json({
    message: 'Hello from Express API',
    timestamp: new Date().toISOString(),
  });
});

router.post('/echo', (req: Request, res: Response) => {
  const { message } = req.body;
  res.json({
    echo: message || '',
    received_at: new Date().toISOString(),
  });
});`,
      },
      {
        path: "src/middleware/errorHandler.ts",
        content: `import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('Error:', err);

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: {
      message,
      statusCode,
      timestamp: new Date().toISOString(),
    },
  });
}`,
      },
      {
        path: ".env.example",
        content: `PORT=3000
NODE_ENV=development`,
      },
      {
        path: ".gitignore",
        content: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Production
dist/
build/

# Environment variables
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db`,
      },
      {
        path: "README.md",
        content: `# {{projectName}}

Express API 服务项目。

## 快速开始

### 安装依赖
\`\`\`bash
npm install
\`\`\`

### 开发模式
\`\`\`bash
npm run dev
\`\`\`

### 生产构建
\`\`\`bash
npm run build
npm start
\`\`\`

## API 端点

- \`GET /health\` - 健康检查
- \`GET /api/hello\` - 示例 GET 端点
- \`POST /api/echo\` - 示例 POST 端点

## 项目结构

\`\`\`
src/
├── index.ts           # 应用入口
├── routes/
│   └── index.ts       # API 路由定义
└── middleware/
    └── errorHandler.ts # 错误处理中间件
\`\`\`

## 环境配置

复制 \`.env.example\` 为 \`.env\` 并根据需要修改配置。

## License

MIT`,
      },
    ],
  },

  "next-app": {
    id: "next-app",
    name: "Next.js 应用",
    description:
      "基于 Next.js 13+ 的现代化全栈应用，包含 App Router、TypeScript 和样式支持",
    category: "fullstack",
    language: "typescript",
    framework: "Next.js",
    version: "14.0",
    files: [
      {
        path: "package.json",
        content: `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "next": "^14.0.0"
  },
  "devDependencies": {
    "typescript": "^5.2.2",
    "@types/node": "^20.3.1",
    "@types/react": "^18.2.8",
    "@types/react-dom": "^18.2.6",
    "@next/eslint-config-next": "^14.0.0"
  }
}`,
      },
      {
        path: "tsconfig.json",
        content: `{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}`,
      },
      {
        path: "next.config.js",
        content: `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
}

module.exports = nextConfig`,
      },
      {
        path: "app/layout.tsx",
        content: `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '{{projectName}}',
  description: 'Next.js 应用示例',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}`,
      },
      {
        path: "app/page.tsx",
        content: `'use client'

import { useState } from 'react'
import styles from './page.module.css'

export default function Home() {
  const [count, setCount] = useState(0)

  return (
    <main className={styles.main}>
      <div className={styles.description}>
        <p>
          欢迎使用 <code>{{projectName}}</code> - Next.js 应用模板
        </p>
      </div>

      <div className={styles.center}>
        <div className={styles.card}>
          <h1>{{projectName}}</h1>
          <button onClick={() => setCount(c => c + 1)}>
            点击数: {count}
          </button>
          <p>编辑 app/page.tsx 后自动保存即可热更新</p>
        </div>
      </div>
    </main>
  )
}`,
      },
      {
        path: "app/page.module.css",
        content: `.main {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 6rem;
  min-height: 100vh;
}

.description {
  display: inherit;
  justify-content: inherit;
  align-items: inherit;
  font-size: 0.85rem;
  max-width: var(--max-width);
  width: 100%;
  z-index: 2;
  font-family: var(--font-mono);
}

.center {
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  padding: 4rem 0;
}

.card {
  padding: 1rem;
  background: rgba(var(--card-rgb), 0.1);
  border: 1px solid rgba(var(--card-border-rgb), 0.15);
  border-radius: 0.625rem;
}`,
      },
      {
        path: "app/globals.css",
        content: `:root {
  --max-width: 1100px;
  --border-radius: 12px;
  --font-mono: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Segoe UI Mono',
    'Roboto Mono', 'Oxygen Mono', 'Ubuntu Monospace', 'source-code-pro',
    'Fira Mono', 'Droid Sans Mono', 'Source Code Pro', monospace;

  --foreground-rgb: 0, 0, 0;
  --background-start-rgb: 214, 219, 220;
  --background-end-rgb: 255, 255, 255;

  --card-rgb: 180, 185, 188;
  --card-border-rgb: 131, 134, 135;
}

@media (prefers-color-scheme: dark) {
  :root {
    --foreground-rgb: 255, 255, 255;
    --background-start-rgb: 0, 0, 0;
    --background-end-rgb: 0, 0, 0;

    --card-rgb: 100, 100, 100;
    --card-border-rgb: 200, 200, 200;
  }
}

* {
  box-sizing: border-box;
  padding: 0;
  margin: 0;
}

html,
body {
  max-width: 100vw;
  overflow-x: hidden;
}

body {
  color: rgb(var(--foreground-rgb));
  background: linear-gradient(
      to bottom,
      transparent,
      rgb(var(--background-end-rgb))
    )
    rgb(var(--background-start-rgb));
}`,
      },
      {
        path: ".gitignore",
        content: `# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.js
/.yarn/install-state.gz

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# local env files
.env*.local

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts`,
      },
      {
        path: "README.md",
        content: `# {{projectName}}

Next.js 13+ 应用项目。

## 快速开始

### 安装依赖
\`\`\`bash
npm install
\`\`\`

### 开发模式
\`\`\`bash
npm run dev
\`\`\`

访问 [http://localhost:3000](http://localhost:3000)

### 生产构建
\`\`\`bash
npm run build
npm start
\`\`\`

## 项目结构

\`\`\`
app/
├── layout.tsx      # 根布局
├── page.tsx        # 主页面
├── page.module.css # 页面样式
└── globals.css     # 全局样式
\`\`\`

## 技术栈

- Next.js 14.0+
- React 18.2+
- TypeScript 5.2+

## License

MIT`,
      },
    ],
  },

  "spring-boot": {
    id: "spring-boot",
    name: "Spring Boot 应用",
    description: "创建 Java Spring Boot REST API 应用，包含依赖管理和基本配置",
    category: "backend",
    language: "java",
    framework: "Spring Boot",
    version: "3.2",
    files: [
      {
        path: "pom.xml",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>{{projectName}}</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <name>{{projectName}}</name>
    <description>Spring Boot REST API 应用</description>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
        <relativePath/>
    </parent>

    <properties>
        <java.version>17</java.version>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>

        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>

        <dependency>
            <groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId>
            <optional>true</optional>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
                <configuration>
                    <excludes>
                        <exclude>
                            <groupId>org.projectlombok</groupId>
                            <artifactId>lombok</artifactId>
                        </exclude>
                    </excludes>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>`,
      },
      {
        path: "src/main/resources/application.yml",
        content: `spring:
  application:
    name: {{projectName}}
  profiles:
    active: dev

server:
  port: 8080
  servlet:
    context-path: /api

logging:
  level:
    root: INFO
    com.example: DEBUG`,
      },
      {
        path: "src/main/java/com/example/Application.java",
        content: `package com.example;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 应用启动类
 */
@SpringBootApplication
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}`,
      },
      {
        path: "src/main/java/com/example/controller/HelloController.java",
        content: `package com.example.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Map;

/**
 * 示例控制器
 */
@RestController
@RequestMapping("/hello")
public class HelloController {

    @GetMapping
    public Map<String, Object> hello() {
        Map<String, Object> response = new HashMap<>();
        response.put("message", "Hello from Spring Boot");
        response.put("timestamp", LocalDateTime.now());
        return response;
    }

    @PostMapping("/echo")
    public Map<String, Object> echo(@RequestBody Map<String, String> request) {
        Map<String, Object> response = new HashMap<>();
        response.put("echo", request.get("message"));
        response.put("received_at", LocalDateTime.now());
        return response;
    }
}`,
      },
      {
        path: ".gitignore",
        content: `# Compiled class file
*.class

# Log file
*.log

# BlueJ files
*.ctxt

# Mobile Tools for Java (J2ME)
.mtj.tmp/

# Package Files #
*.jar
*.war
*.nar
*.ear
*.zip
*.tar.gz
*.rar

# virtual machine crash logs, see http://www.java.com/en/download/help/error_hotspot.xml
hs_err_pid*

# IDEs
.idea/
.vscode/
*.swp
*.swo
*.iml

# Maven
target/
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties
dependency-reduced-pom.xml

# Build
.gradle/
build/`,
      },
      {
        path: "README.md",
        content: `# {{projectName}}

Spring Boot 应用项目。

## 快速开始

### 构建
\`\`\`bash
mvn clean package
\`\`\`

### 运行
\`\`\`bash
mvn spring-boot:run
\`\`\`

应用将运行在 http://localhost:8080/api

## API 端点

- \`GET /api/hello\` - 示例 GET 端点
- \`POST /api/hello/echo\` - 示例 POST 端点

## 项目结构

\`\`\`
src/main/java/com/example/
├── Application.java              # 应用启动类
└── controller/
    └── HelloController.java      # 示例控制器

src/main/resources/
└── application.yml               # 应用配置
\`\`\`

## 技术栈

- Java 17+
- Spring Boot 3.2+
- Maven

## License

MIT`,
      },
    ],
  },

  "react-app": {
    id: "react-app",
    name: "Create React App",
    description:
      "使用 Create React App 快速创建的 React 项目，包含基础配置和示例",
    category: "frontend",
    language: "javascript",
    framework: "React",
    version: "18.0",
    files: [
      {
        path: "package.json",
        content: `{
  "name": "{{projectName}}",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-scripts": "5.0.1"
  },
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  },
  "eslintConfig": {
    "extends": [
      "react-app"
    ]
  },
  "browserslist": {
    "production": [
      ">0.2%",
      "not dead",
      "not op_mini all"
    ],
    "development": [
      "last 1 chrome version",
      "last 1 firefox version",
      "last 1 safari version"
    ]
  }
}`,
      },
      {
        path: "public/index.html",
        content: `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <noscript>你需要启用 JavaScript 来运行该应用。</noscript>
    <div id="root"></div>
  </body>
</html>`,
      },
      {
        path: "src/index.js",
        content: `import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`,
      },
      {
        path: "src/App.js",
        content: `import { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="App">
      <header className="App-header">
        <h1>{{projectName}}</h1>
        <p>欢迎使用 React 项目模板</p>
        <button onClick={() => setCount(count + 1)}>
          点击数: {count}
        </button>
        <p>
          编辑 <code>src/App.js</code> 并保存即可看到变化
        </p>
      </header>
    </div>
  );
}

export default App;`,
      },
      {
        path: "src/index.css",
        content: `body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code {
  font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New',
    monospace;
}`,
      },
      {
        path: "src/App.css",
        content: `.App {
  text-align: center;
}

.App-header {
  background-color: #282c34;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-size: calc(10px + 2vmin);
  color: white;
}

.App-header h1 {
  margin: 0 0 20px 0;
}

.App-header button {
  background-color: #61dafb;
  border: none;
  color: #282c34;
  padding: 12px 24px;
  font-size: 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  margin: 20px 0;
}

.App-header button:hover {
  background-color: #4fa8c5;
}`,
      },
      {
        path: ".gitignore",
        content: `# Dependencies
/node_modules
/.pnp
.pnp

# Testing
/coverage

# Production
/build

# Misc
.DS_Store
.env.local
.env.development.local
.env.test.local
.env.production.local

npm-debug.log*
yarn-debug.log*
yarn-error.log*`,
      },
      {
        path: "README.md",
        content: `# {{projectName}}

这是一个使用 Create React App 创建的 React 项目。

## 快速开始

### 安装依赖
\`\`\`bash
npm install
\`\`\`

### 开发模式
\`\`\`bash
npm start
\`\`\`

### 构建生产版本
\`\`\`bash
npm run build
\`\`\`

## 可用的脚本

- \`npm start\` - 启动开发服务器
- \`npm run build\` - 构建生产版本
- \`npm test\` - 运行测试

## License

MIT`,
      },
    ],
  },
};

export function getTemplate(
  templateId: string,
): TemplateDefinition | undefined {
  return templates[templateId];
}

export function listTemplates(): TemplateDefinition[] {
  return Object.values(templates);
}

export function listTemplatesByCategory(
  category: string,
): TemplateDefinition[] {
  return Object.values(templates).filter((t) => t.category === category);
}
