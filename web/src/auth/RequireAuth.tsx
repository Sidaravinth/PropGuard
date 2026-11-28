import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "./AuthContext";

/** Protected route: unauthenticated visitors are sent to /login; after signing in they land on the dashboard. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <div className="fullscreen-center">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }
  if (status === "signed-out") return <Navigate to="/login" replace />;
  return <>{children}</>;
}
