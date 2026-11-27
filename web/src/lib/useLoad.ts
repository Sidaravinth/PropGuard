import { useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "../api/client";

/** Load data once (and on demand). Keeps the last good data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not load data");
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

export const errorMessage = (e: unknown, fallback = "Something went wrong") => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);
