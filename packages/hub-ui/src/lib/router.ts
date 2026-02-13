/**
 * Simple hash-based client-side router
 */

export type RouteHandler = (params: Record<string, string>) => void;

export interface Route {
  pattern: RegExp;
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  private currentRoute: string | null = null;

  constructor() {
    window.addEventListener("hashchange", () => this.handleRoute());
    window.addEventListener("load", () => this.handleRoute());
  }

  add(pattern: string, handler: RouteHandler): void {
    // Convert pattern like "/channels/:id" to regex
    const regexPattern = pattern
      .replace(/:[^/]+/g, "([^/]+)")
      .replace(/\//g, "\\/");
    
    const regex = new RegExp(`^${regexPattern}$`);
    this.routes.push({ pattern: regex, handler });
  }

  navigate(path: string): void {
    window.location.hash = path;
  }

  private handleRoute(): void {
    const hash = window.location.hash.slice(1) || "/";
    
    if (hash === this.currentRoute) {
      return; // Already on this route
    }

    this.currentRoute = hash;

    for (const route of this.routes) {
      const match = hash.match(route.pattern);
      if (match) {
        // Extract params from match groups
        const params: Record<string, string> = {};
        // Simple param extraction - for now just numeric indices
        for (let i = 1; i < match.length; i++) {
          params[`param${i}`] = match[i];
        }
        route.handler(params);
        return;
      }
    }

    // No match - default to home
    this.navigate("/");
  }

  getCurrentPath(): string {
    return window.location.hash.slice(1) || "/";
  }
}
