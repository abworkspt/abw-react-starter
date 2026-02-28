#!/usr/bin/env node

import {
  Command
} from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import {
  execa
} from "execa";
import crypto from "crypto";

const program = new Command();
const MANIFEST_NAME = ".abw-starter.json";

function randHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function run(cmd, args, opts = {}) {
  const p = execa(cmd, args, {
    stdio: "inherit",
    ...opts
  });
  await p;
}

async function runCapture(cmd, args, opts = {}) {
  const p = await execa(cmd, args, {
    ...opts
  });
  return p.stdout?.trim();
}

function ensureNoTrailingSlash(url) {
  return (url || "").replace(/\/+$/, "");
}

async function assertCmdExists(cmd, args = ["--version"]) {
  try {
    await execa(cmd, args, {
      stdio: "ignore"
    });
  } catch {
    throw new Error(`Falta o comando "${cmd}" no PATH. Instala-o e tenta novamente.`);
  }
}

async function assertHerokuLoggedIn() {
  try {
    await execa("heroku", ["auth:whoami"], {
      stdio: "ignore"
    });
  } catch {
    throw new Error(`Heroku CLI não autenticado. Corre "heroku login" e tenta novamente.`);
  }
}

async function writeManifest(projectDir, data) {
  const manifestPath = path.join(projectDir, MANIFEST_NAME);
  await fs.writeJson(manifestPath, data, {
    spaces: 2
  });
}

async function readManifest(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_NAME);
  if (!(await fs.pathExists(manifestPath))) return null;
  return fs.readJson(manifestPath);
}

function resolveProjectDir(p) {
  return path.resolve(process.cwd(), p || ".");
}

async function ensureEmptyDir(projectDir) {
  if (await fs.pathExists(projectDir)) {
    throw new Error(`A pasta já existe: ${projectDir}`);
  }
}

async function initGitRepo(cwd, message) {
  await run("git", ["init"], {
    cwd
  });
  await run("git", ["add", "."], {
    cwd
  });
  await run("git", ["commit", "-m", message], {
    cwd
  });
  await run("git", ["branch", "-M", "main"], {
    cwd
  });
}

async function createBackendLocal(projectDir) {
  console.log("\n=== BACKEND: criar Strapi ===\n");
  await run("npx", [
    "create-strapi-app@latest",
    "backend",
    "--non-interactive",
    "--skip-cloud",
    "--no-run",
    "--dbclient", "sqlite",
    "--dbfile", ".tmp/data.db",
    "--no-example",
    "--typescript",
    "--use-npm",
    "--install",
    "--no-git-init",
  ], {
    cwd: projectDir
  });

  console.log("\n=== BACKEND: instalar pg ===\n");
  await run("npm", ["i", "pg"], {
    cwd: path.join(projectDir, "backend")
  });

  console.log("\n=== BACKEND: git init/commit ===\n");
  await initGitRepo(path.join(projectDir, "backend"), "Init Strapi backend");
}

async function createFrontendLocal(projectDir, nodeVersion) {
  console.log("\n=== FRONTEND: criar Next.js ===\n");
  await run("npx", ["create-next-app@latest", "frontend"], {
    cwd: projectDir
  });

  const feDir = path.join(projectDir, "frontend");

  // Ajustar next.config.ts -> js se existir
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
  pkg.engines.node = nodeVersion;

  pkg.scripts = pkg.scripts || {};
  pkg.scripts.build = pkg.scripts.build || "next build";
  pkg.scripts.start = "next start -p $PORT";

  await fs.writeJson(pkgPath, pkg, {
    spaces: 2
  });

  // .env.local para dev (localhost)
  const envLocalPath = path.join(feDir, ".env.local");
  if (!(await fs.pathExists(envLocalPath))) {
    await fs.writeFile(envLocalPath, "NEXT_PUBLIC_STRAPI_URL=http://localhost:1337\n");
  }

  console.log("\n=== FRONTEND: git init/commit ===\n");
  await initGitRepo(feDir, "Init Next frontend");
}

async function deployBackendHeroku({
  projectDir,
  backendApp,
  region
}) {
  const beDir = path.join(projectDir, "backend");

  console.log("\n=== BACKEND: criar app Heroku + Postgres ===\n");
  await run("heroku", ["create", backendApp, "--region", region], {
    cwd: beDir
  });
  await run("heroku", ["git:remote", "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["addons:create", "heroku-postgresql", "-a", backendApp], {
    cwd: beDir
  });

  console.log("\n=== BACKEND: configurar env vars Strapi ===\n");
  const appKeys = [randHex(16), randHex(16), randHex(16), randHex(16)].join(",");
  const apiTokenSalt = randHex(16);
  const adminJwtSecret = randHex(24);
  const jwtSecret = randHex(24);

  await run("heroku", ["config:set", `NODE_ENV=production`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `APP_KEYS=${appKeys}`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `API_TOKEN_SALT=${apiTokenSalt}`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `ADMIN_JWT_SECRET=${adminJwtSecret}`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `JWT_SECRET=${jwtSecret}`, "-a", backendApp], {
    cwd: beDir
  });

  // DB settings (ajustes para Heroku)
  await run("heroku", ["config:set", `DATABASE_CLIENT=postgres`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `DATABASE_SSL=true`, "-a", backendApp], {
    cwd: beDir
  });
  await run("heroku", ["config:set", `DATABASE_SSL_REJECT_UNAUTHORIZED=false`, "-a", backendApp], {
    cwd: beDir
  });

  console.log("\n=== BACKEND: deploy ===\n");
  await run("git", ["push", "heroku", "main"], {
    cwd: beDir
  });

  const backendUrlRaw = await runCapture("heroku", ["apps:info", "-a", backendApp, "--json"]);
  const backendInfo = JSON.parse(backendUrlRaw || "{}");
  const backendWebUrl = ensureNoTrailingSlash(backendInfo?.app?.web_url);

  if (!backendWebUrl) throw new Error("Não consegui obter web_url do backend no Heroku.");

  return backendWebUrl;
}

async function deployFrontendHeroku({
  projectDir,
  frontendApp,
  region,
  backendWebUrl
}) {
  const feDir = path.join(projectDir, "frontend");

  console.log("\n=== FRONTEND: criar app Heroku ===\n");
  await run("heroku", ["create", frontendApp, "--region", region], {
    cwd: feDir
  });
  await run("heroku", ["git:remote", "-a", frontendApp], {
    cwd: feDir
  });

  console.log("\n=== FRONTEND: configurar env var ===\n");
  await run("heroku", ["config:set", `NEXT_PUBLIC_STRAPI_URL=${backendWebUrl}`, "-a", frontendApp], {
    cwd: feDir
  });

  console.log("\n=== FRONTEND: deploy ===\n");
  await run("git", ["push", "heroku", "main"], {
    cwd: feDir
  });

  const frontendUrlRaw = await runCapture("heroku", ["apps:info", "-a", frontendApp, "--json"]);
  const frontendInfo = JSON.parse(frontendUrlRaw || "{}");
  const frontendWebUrl = ensureNoTrailingSlash(frontendInfo?.app?.web_url);

  if (!frontendWebUrl) throw new Error("Não consegui obter web_url do frontend no Heroku.");

  return frontendWebUrl;
}

async function doCreate(projectDirArg, opts) {
  await assertCmdExists("git");
  await assertCmdExists("node");
  await assertCmdExists("npm");

  const projectDir = resolveProjectDir(projectDirArg);
  await ensureEmptyDir(projectDir);

  const projectBase = path.basename(projectDir);
  const region = (opts.region || "eu").toLowerCase();
  const nodeVersion = opts.node || "20.x";

  // Pergunta só a opção (sem flags)
  const {
    deployNow
  } = await inquirer.prompt([{
    type: "confirm",
    name: "deployNow",
    message: "Queres publicar no Heroku agora?",
    default: true,
  }, ]);

  // Se não for publicar agora, não precisamos de Heroku
  let backendApp = opts.backendApp || `${projectBase}-api`;
  let frontendApp = opts.frontendApp || `${projectBase}-web`;

  // Criar estrutura e apps localmente
  await fs.ensureDir(projectDir);
  await fs.ensureDir(path.join(projectDir, "backend"));
  await fs.ensureDir(path.join(projectDir, "frontend"));

  await createBackendLocal(projectDir);
  await createFrontendLocal(projectDir, nodeVersion);

  // Guardar manifest (para publish posterior)
  await writeManifest(projectDir, {
    version: 1,
    region,
    nodeVersion,
    backendApp,
    frontendApp,
    createdAt: new Date().toISOString(),
    deployedAt: null,
    backendUrl: null,
    frontendUrl: null,
  });

  if (!deployNow) {
    console.log("\n✅ Projeto criado localmente (sem Heroku).");
    console.log(`📁 Pasta: ${projectDir}`);
    console.log("\nPara correr local:");
    console.log("- Backend: cd backend && npm run develop");
    console.log("- Frontend: cd frontend && npm run dev");
    console.log("\nQuando quiseres publicar:");
    console.log(`- abw-react-starter publish "${projectDir}"`);
    return;
  }

  // Se for publicar agora, então pedimos os nomes (aqui) e validamos Heroku
  const publishAnswers = await inquirer.prompt([{
      type: "input",
      name: "backendApp",
      message: "Nome da app Heroku do backend (Strapi):",
      default: backendApp,
      validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
    },
    {
      type: "input",
      name: "frontendApp",
      message: "Nome da app Heroku do frontend (Next):",
      default: frontendApp,
      validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
    },
    {
      type: "confirm",
      name: "confirm",
      message: "Confirmas criar 2 apps Heroku e fazer deploy?",
      default: true,
    },
  ]);

  if (!publishAnswers.confirm) {
    console.log("\n✅ Projeto criado localmente (não publicaste no Heroku).");
    console.log(`Quando quiseres publicar: abw-react-starter publish "${projectDir}"`);
    return;
  }

  backendApp = publishAnswers.backendApp;
  frontendApp = publishAnswers.frontendApp;

  // Atualiza manifest com nomes escolhidos
  const m = (await readManifest(projectDir)) || {};
  await writeManifest(projectDir, {
    ...m,
    backendApp,
    frontendApp
  });

  await doPublish(projectDir);
}

async function doPublish(projectDirArg) {
  const projectDir = resolveProjectDir(projectDirArg);

  await assertCmdExists("git");
  await assertCmdExists("heroku");
  await assertHerokuLoggedIn();

  const manifest = await readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `Não encontrei ${MANIFEST_NAME} em ${projectDir}. Cria o projeto com "abw-react-starter create <dir>" primeiro.`
    );
  }

  const region = (manifest.region || "eu").toLowerCase();
  const backendDir = path.join(projectDir, "backend");
  const frontendDir = path.join(projectDir, "frontend");

  if (!(await fs.pathExists(backendDir))) throw new Error("Não encontrei a pasta backend.");
  if (!(await fs.pathExists(frontendDir))) throw new Error("Não encontrei a pasta frontend.");

  // Se por alguma razão não houver nomes, pergunta agora
  let backendApp = manifest.backendApp;
  let frontendApp = manifest.frontendApp;

  if (!backendApp || !frontendApp) {
    const projectBase = path.basename(projectDir);
    const a = await inquirer.prompt([{
        type: "input",
        name: "backendApp",
        message: "Nome da app Heroku do backend (Strapi):",
        default: backendApp || `${projectBase}-api`,
        validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
      },
      {
        type: "input",
        name: "frontendApp",
        message: "Nome da app Heroku do frontend (Next):",
        default: frontendApp || `${projectBase}-web`,
        validate: (v) => (v?.length >= 3 ? true : "Nome muito curto"),
      },
    ]);
    backendApp = a.backendApp;
    frontendApp = a.frontendApp;
    await writeManifest(projectDir, {
      ...manifest,
      backendApp,
      frontendApp
    });
  }

  const backendWebUrl = await deployBackendHeroku({
    projectDir,
    backendApp,
    region
  });
  const frontendWebUrl = await deployFrontendHeroku({
    projectDir,
    frontendApp,
    region,
    backendWebUrl,
  });

  const updated = await readManifest(projectDir);
  await writeManifest(projectDir, {
    ...updated,
    deployedAt: new Date().toISOString(),
    backendUrl: backendWebUrl,
    frontendUrl: frontendWebUrl,
  });

  console.log("\n✅ Tudo pronto!");
  console.log(`Backend (Strapi): ${backendWebUrl}`);
  console.log(`Admin: ${backendWebUrl}/admin`);
  console.log(`Frontend (Next): ${frontendWebUrl}`);
  console.log("\nNotas:");
  console.log("- Content types normalmente crias localmente e depois fazes push para o backend Heroku.");
  console.log("- Em produção, dá permissões em Public role para expor endpoints.");
}

program.name("abw-react-starter");

// Comando create (default)
program
  .command("create")
  .argument("<projectDir>", "Diretório do projeto (será criado)")
  .option("--backend-app <name>", "Nome da app Heroku do backend (Strapi)")
  .option("--frontend-app <name>", "Nome da app Heroku do frontend (Next)")
  .option("--node <version>", "Versão Node para Heroku (ex: 20.x)", "20.x")
  .option("--region <region>", "Heroku region (eu | us)", "eu")
  .action(async (projectDirArg, opts) => {
    await doCreate(projectDirArg, opts);
  });

// Para compatibilidade: se chamarem sem "create", trata como create
program
  .argument("[projectDir]", "Diretório do projeto (será criado)")
  .option("--backend-app <name>", "Nome da app Heroku do backend (Strapi)")
  .option("--frontend-app <name>", "Nome da app Heroku do frontend (Next)")
  .option("--node <version>", "Versão Node para Heroku (ex: 20.x)", "20.x")
  .option("--region <region>", "Heroku region (eu | us)", "eu");

// Comando publish
program
  .command("publish")
  .argument("[projectDir]", "Diretório do projeto (default: .)")
  .description("Publicar um projeto existente no Heroku")
  .action(async (projectDirArg) => {
    await doPublish(projectDirArg || ".");
  });

// Se executarem sem subcomando, faz create
program.action(async (projectDirArg, opts) => {
  if (!projectDirArg) {
    program.help();
    return;
  }
  await doCreate(projectDirArg, opts);
});

program.parseAsync(process.argv).catch((err) => {
  console.error("\n❌ Erro:", err?.message || err);
  process.exit(1);
});