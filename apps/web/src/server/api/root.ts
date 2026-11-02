import { examRouter } from "./routers/exam";
import { oidcRouter } from "~/server/api/routers/oidc";
import { appearanceRouter } from "~/server/api/routers/appearance";
import {
  createCallerFactory,
  createTRPCRouter,
  publicProcedure,
} from "~/server/api/trpc";
import { dashboardRouter } from "~/server/api/routers/dashboard";
import { backgroundWorkRouter } from "~/server/api/routers/backgroundWork";
import { accountRouter } from "~/server/api/routers/account";
import { adminProjectRouter } from "~/server/api/routers/adminProject";
import { apiKeyRouter } from "~/server/api/routers/apiKey";
import { artifactRouter } from "~/server/api/routers/artifact";
import { assistantRouter } from "~/server/api/routers/assistant";
import { diagnosticsRouter } from "~/server/api/routers/diagnostics";
import { documentRouter } from "~/server/api/routers/document";
import { folderRouter } from "~/server/api/routers/folder";
import { graphRouter } from "~/server/api/routers/graph";
import { ingestionRouter } from "~/server/api/routers/ingestion";
import { ingestionAdminRouter } from "~/server/api/routers/ingestionAdmin";
import { knowledgeRouter } from "~/server/api/routers/knowledge";
import { llmRouter } from "~/server/api/routers/llm";
import { oauthConsentRouter } from "~/server/api/routers/oauthConsent";
import { projectRouter } from "~/server/api/routers/project";
import { projectGitRemoteRouter } from "~/server/api/routers/projectGitRemote";
import { wikiRouter } from "~/server/api/routers/wiki";
import { projectApiKeyRouter } from "~/server/api/routers/projectApiKey";
import { projectMemberRouter } from "~/server/api/routers/projectMember";
import { remoteInstanceRouter } from "~/server/api/routers/remoteInstance";
import { reviewRouter } from "~/server/api/routers/review";
import { reviewerGroupRouter } from "~/server/api/routers/reviewerGroup";
import { scheduledTaskRouter } from "~/server/api/routers/scheduledTask";
import { searchRouter } from "~/server/api/routers/search";
import { tableRouter } from "~/server/api/routers/table";
import { tableFolderRouter } from "~/server/api/routers/tableFolder";
import { userRouter } from "~/server/api/routers/user";
import { externalMcpRouter } from "~/server/api/routers/externalMcp";

// `_meta.health` keeps the router type non-empty (tRPC v11's hydration
// helpers reject zero-procedure routers at the type level).
const metaRouter = createTRPCRouter({
  health: publicProcedure.query(() => ({ ok: true as const })),
});

export const appRouter = createTRPCRouter({
  exam: examRouter,
  _meta: metaRouter,
  account: accountRouter,
  appearance: appearanceRouter,
  adminProject: adminProjectRouter,
  backgroundWork: backgroundWorkRouter,
  dashboard: dashboardRouter,
  apiKey: apiKeyRouter,
  artifact: artifactRouter,
  assistant: assistantRouter,
  diagnostics: diagnosticsRouter,
  document: documentRouter,
  externalMcp: externalMcpRouter,
  folder: folderRouter,
  graph: graphRouter,
  ingestion: ingestionRouter,
  ingestionAdmin: ingestionAdminRouter,
  knowledge: knowledgeRouter,
  llm: llmRouter,
  oauthConsent: oauthConsentRouter,
  oidc: oidcRouter,
  project: projectRouter,
  projectApiKey: projectApiKeyRouter,
  projectGitRemote: projectGitRemoteRouter,
  projectMember: projectMemberRouter,
  remoteInstance: remoteInstanceRouter,
  review: reviewRouter,
  reviewerGroup: reviewerGroupRouter,
  scheduledTask: scheduledTaskRouter,
  search: searchRouter,
  table: tableRouter,
  tableFolder: tableFolderRouter,
  user: userRouter,
  wiki: wikiRouter,
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
