import { Container } from "@cloudflare/containers";

export class AiposterRenderer extends Container {
  defaultPort = 8788;
  requiredPorts = [8788];
  sleepAfter = "10m";
  pingEndpoint = "/health";
}

function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {})
    }
  });
}

function isAuthorized(request, env) {
  const token = env.RENDERER_TOKEN || "";
  if (!token) {
    return false;
  }

  return request.headers.get("authorization") === `Bearer ${token}`;
}

async function forwardToRenderer(request, env) {
  const container = env.RENDERER.getRandom();
  await container.startAndWaitForPorts();
  return container.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "aiposter-renderer-proxy" });
    }

    if (url.pathname !== "/render" || request.method !== "POST") {
      return json({ ok: false, message: "Not found." }, { status: 404 });
    }

    if (!isAuthorized(request, env)) {
      return json({ ok: false, message: "Renderer token is invalid." }, { status: 401 });
    }

    return forwardToRenderer(request, env);
  }
};
