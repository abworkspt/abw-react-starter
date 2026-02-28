#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { execa } from "execa";
import crypto from "crypto";

const program = new Command();

function randHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function run(cmd, args, opts = {}) {
  const p = execa(cmd, args, { stdio: "inherit", ...opts });
  await p;
}

async function runCapture(cmd, args, opts = {}) {
  const p = await execa(cmd, args, { ...opts });
  return p.stdout?.trim();
}

function ensureNoTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

async function assertCmdExists(cmd, args = ["--version"]) {
  try {
    await execa(cmd, args, { stdio: "ignore" });
  } catch {
    throw new Error(`Falta o comando "${cmd}" no PATH. Instala-o e tenta novamente.`);
  }
}

program
  .name("create-heroku-next-strapi")
  .argument("<projectDir>", "Diretório do projeto (será criado)")
  .option("--backend-app <name>", "Nome da app Heroku do backend (Strapi)")
  .option("--frontend-app <name>", "Nome da app Heroku do frontend (Next)")
  .option("--node <version>", "Versão Node para Heroku (ex: 20.x)", "20.x")
  .option("--no-typescript", "Criar Next sem TypeScript")
  .parse(process.argv);

const opts = program.opts();
const [projectDirArg] = program.args;

async function main() {
  await assertCmdExists("git");
  await assertCmdExists("heroku");
  await assertCmdExists("node");
  await assertCmdExists("npm");

  // Verifica login Heroku
  try {
    await execa("heroku", ["auth:whoami"], { stdio: "ignore" });
  } catch {
    throw new Error(`Heroku CLI não autenticado. Corre "heroku login" e tenta novamente.`);
  }

  const projectDir = path.resolve(process.cwd(), projectDirArg);
  if (await fs.pathExists(projectDir)) {
    throw new Error(`A pasta já existe: ${projectDir}`);
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "backendApp",
      message: "Nome da app Heroku do backend (Strapi):",
      default: opts.backendApp || `${path.basename(projectDir)}-api`,
      validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
    },
    {
      type: "input",
      name: "frontendApp",
      message: "Nome da app Heroku do frontend (Next):",
      default: opts.frontendApp || `${path.basename(projectDir)}-web`,
      validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
    },
    {
      type: "confirm",
      name: "confirm",
      message: "Confirmas criar 2 apps Heroku e fazer deploy?",
      default: true,
    },
  ]);

  if (!answers.confirm) return;

  const backendApp = answers.backendApp;
  const frontendApp = answers.frontendApp;

  // 0) criar estrutura
  await fs.ensureDir(projectDir);
  await fs.ensureDir(path.join(projectDir, "backend"));
  await fs.ensureDir(path.join(projectDir, "frontend"));

  // ======================
  // BACKEND: STRAPI
  // ======================
  console.log("\n=== BACKEND: criar Strapi ===\n");
  // cria Strapi (sem quickstart para ser “blank” e escolher config)
  // Nota: create-strapi-app pode pedir prompts. Para zero prompts, terias de fixar opções.
  await run("npx", ["create-strapi-app@latest", "backend"], { cwd: projectDir });

  // instala pg
  console.log("\n=== BACKEND: instalar pg ===\n");
  await run("npm", ["i", "pg"], { cwd: path.join(projectDir, "backend") });

  // inicializa git no backend
  console.log("\n=== BACKEND: git init/commit ===\n");
  await run("git", ["init"], { cwd: path.join(projectDir, "backend") });
  await run("git", ["add", "."], { cwd: path.join(projectDir, "backend") });
  await run("git", ["commit", "-m", "Init Strapi backend"], { cwd: path.join(projectDir, "backend") });

  // criar app no heroku
  console.log("\n=== BACKEND: criar app Heroku + Postgres ===\n");
  await run("heroku", ["create", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["git:remote", "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["addons:create", "heroku-postgresql", "-a", backendApp], { cwd: path.join(projectDir, "backend") });

  // env vars do Strapi
  console.log("\n=== BACKEND: configurar env vars Strapi ===\n");
  const appKeys = [randHex(16), randHex(16), randHex(16), randHex(16)].join(",");
  const apiTokenSalt = randHex(16);
  const adminJwtSecret = randHex(24);
  const jwtSecret = randHex(24);

  await run("heroku", ["config:set", `NODE_ENV=production`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `APP_KEYS=${appKeys}`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `API_TOKEN_SALT=${apiTokenSalt}`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `ADMIN_JWT_SECRET=${adminJwtSecret}`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `JWT_SECRET=${jwtSecret}`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });

  // DB settings (ajustes para Heroku)
  await run("heroku", ["config:set", `DATABASE_CLIENT=postgres`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `DATABASE_SSL=true`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });
  await run("heroku", ["config:set", `DATABASE_SSL_REJECT_UNAUTHORIZED=false`, "-a", backendApp], { cwd: path.join(projectDir, "backend") });

  // deploy backend
  console.log("\n=== BACKEND: deploy ===\n");
  // garantir branch main
  await run("git", ["branch", "-M", "main"], { cwd: path.join(projectDir, "backend") });
  await run("git", ["push", "heroku", "main"], { cwd: path.join(projectDir, "backend") });

  // obter URL do backend
  const backendUrlRaw = await runCapture("heroku", ["apps:info", "-a", backendApp, "--json"]);
  const backendInfo = JSON.parse(backendUrlRaw);
  const backendWebUrl = ensureNoTrailingSlash(backendInfo?.app?.web_url || "");
  if (!backendWebUrl) {
    throw new Error("Não consegui obter web_url do backend no Heroku.");
  }

  // ======================
  // FRONTEND: NEXT
  // ======================
  console.log("\n=== FRONTEND: criar Next.js ===\n");
  const nextArgs = ["create-next-app@latest", "frontend"];
  await run("npx", nextArgs, { cwd: projectDir });

  // Ajustar next.config.ts -> js se existir
  const feDir = path.join(projectDir, "frontend");
  const nextConfigTs = path.join(feDir, "next.config.ts");
  const nextConfigJs = path.join(feDir, "next.config.js");
  if (await fs.pathExists(nextConfigTs)) {
    await fs.remove(nextConfigTs);
    await fs.writeFile(
      nextConfigJs,
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nmodule.exports = nextConfig;\n`
    );
  } else if (!(await fs.pathExists(nextConfigJs))) {
    await fs.writeFile(
      nextConfigJs,
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nmodule.exports = nextConfig;\n`
    );
  }

  // Garantir engines node e start -p $PORT
  const pkgPath = path.join(feDir, "package.json");
  const pkg = await fs.readJson(pkgPath);

  pkg.engines = pkg.engines || {};
  pkg.engines.node = opts.node;

  pkg.scripts = pkg.scripts || {};
  pkg.scripts.build = pkg.scripts.build || "next build";
  pkg.scripts.start = "next start -p $PORT";

  await fs.writeJson(pkgPath, pkg, { spaces: 2 });

  // .env.local para dev (localhost) + nota
  const envLocalPath = path.join(feDir, ".env.local");
  if (!(await fs.pathExists(envLocalPath))) {
    await fs.writeFile(envLocalPath, "NEXT_PUBLIC_STRAPI_URL=http://localhost:1337\n");
  }

  // git init no frontend
  console.log("\n=== FRONTEND: git init/commit ===\n");
  await run("git", ["init"], { cwd: feDir });
  await run("git", ["add", "."], { cwd: feDir });
  await run("git", ["commit", "-m", "Init Next frontend"], { cwd: feDir });

  // heroku create frontend
  console.log("\n=== FRONTEND: criar app Heroku ===\n");
  await run("heroku", ["create", frontendApp], { cwd: feDir });
  await run("heroku", ["git:remote", "-a", frontendApp], { cwd: feDir });

  // set env do frontend para apontar para backend
  console.log("\n=== FRONTEND: configurar env var ===\n");
  await run("heroku", ["config:set", `NEXT_PUBLIC_STRAPI_URL=${backendWebUrl}`, "-a", frontendApp], { cwd: feDir });

  // deploy frontend
  console.log("\n=== FRONTEND: deploy ===\n");
  await run("git", ["branch", "-M", "main"], { cwd: feDir });
  await run("git", ["push", "heroku", "main"], { cwd: feDir });

  const frontendUrlRaw = await runCapture("heroku", ["apps:info", "-a", frontendApp, "--json"]);
  const frontendInfo = JSON.parse(frontendUrlRaw);
  const frontendWebUrl = ensureNoTrailingSlash(frontendInfo?.app?.web_url || "");

  console.log("\n✅ Tudo pronto!");
  console.log(`Backend (Strapi): ${backendWebUrl}`);
  console.log(`Admin: ${backendWebUrl}/admin`);
  console.log(`Frontend (Next): ${frontendWebUrl}`);
  console.log("\nNotas:");
  console.log("- Content types só se criam localmente e depois fazes push para o backend Heroku.");
  console.log("- Em produção, dá permissões em Public role para expor endpoints.");
}

main().catch((err) => {
  console.error("\n❌ Erro:", err?.message || err);
  process.exit(1);
});