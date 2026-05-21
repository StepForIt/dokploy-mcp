// AUTO-GENERATED FILE — DO NOT EDIT MANUALLY
// Generated from openapi.json on 2026-05-21
// Run `pnpm generate` to regenerate

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const generatedTools: ToolDefinition[] = [
  {
    name: "admin-setupMonitoring",
    description: "SetupMonitoring Dokploy admin. POST /admin.setupMonitoring",
    tag: "admin",
    method: "POST",
    path: "/admin.setupMonitoring",
    schema: z.object({ "metricsConfig": z.object({ "server": z.object({ "refreshRate": z.number().gte(2), "port": z.number().gte(1), "token": z.string(), "urlCallback": z.string().url(), "retentionDays": z.number().gte(1), "cronJob": z.string().min(1), "thresholds": z.object({ "cpu": z.number().gte(0), "memory": z.number().gte(0) }) }), "containers": z.object({ "refreshRate": z.number().gte(2), "services": z.object({ "include": z.array(z.string()).optional(), "exclude": z.array(z.string()).optional() }) }) }) }),
    annotations: {
      title: "Admin SetupMonitoring",
      ...{"idempotentHint":true,"openWorldHint":true},
    },
  },
  {
    name: "application-create",
    description: "Create a new Dokploy application. POST /application.create",
    tag: "application",
    method: "POST",
    path: "/application.create",
    schema: z.object({ "name": z.string().min(1), "appName": z.string().regex(new RegExp("^[a-zA-Z0-9._-]+$")).min(1).max(63).optional(), "description": z.union([z.string(), z.null()]).optional(), "environmentId": z.string(), "serverId": z.union([z.string(), z.null()]).optional() }),
    annotations: {
      title: "Application Create",
      ...{"openWorldHint":true},
    },
  },
  {
    name: "application-one",
    description: "Get a single Dokploy application by ID. GET /application.one",
    tag: "application",
    method: "GET",
    path: "/application.one",
    schema: z.object({ "applicationId": z.string().min(1) }),
    annotations: {
      title: "Application One",
      ...{"readOnlyHint":true,"idempotentHint":true,"openWorldHint":true},
    },
  },
  {
    name: "compose-create",
    description: "Create a new Dokploy compose. POST /compose.create",
    tag: "compose",
    method: "POST",
    path: "/compose.create",
    schema: z.object({ "name": z.string().min(1), "description": z.union([z.string(), z.null()]).optional(), "environmentId": z.string(), "composeType": z.enum(["docker-compose","stack"]).optional(), "appName": z.string().regex(new RegExp("^[a-zA-Z0-9._-]+$")).min(1).max(63).optional(), "serverId": z.union([z.string(), z.null()]).optional(), "composeFile": z.string().optional() }),
    annotations: {
      title: "Compose Create",
      ...{"openWorldHint":true},
    },
  },
  {
    name: "project-create",
    description: "Create a new Dokploy project. POST /project.create",
    tag: "project",
    method: "POST",
    path: "/project.create",
    schema: z.object({ "name": z.string().min(1), "description": z.union([z.string(), z.null()]).optional(), "env": z.string().optional() }),
    annotations: {
      title: "Project Create",
      ...{"openWorldHint":true},
    },
  },
  {
    name: "project-all",
    description: "List all projects in Dokploy. GET /project.all",
    tag: "project",
    method: "GET",
    path: "/project.all",
    schema: z.object({}),
    annotations: {
      title: "Project All",
      ...{"readOnlyHint":true,"idempotentHint":true,"openWorldHint":true},
    },
  },
];
