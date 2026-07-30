export type AsyncRefreshMode = "background" | "blocking";

export type AsyncRefreshPreparation<T> = {
  value: T;
  mode: AsyncRefreshMode;
  shared: boolean;
};

type PrepareOptions<T> = {
  staleValue?: T;
  staleWhileRevalidate: boolean;
  refresh: () => Promise<T>;
};

export function canServeStaleSnapshot(options: {
  enabled: boolean;
  hasSnapshot: boolean;
  ageMs: number;
  maxAgeMs: number;
}): boolean {
  return (
    options.enabled &&
    options.hasSnapshot &&
    options.ageMs <= options.maxAgeMs
  );
}

export class AsyncRefreshCoordinator<T> {
  private inFlight: Promise<T> | undefined;

  async prepare(
    options: PrepareOptions<T>,
  ): Promise<AsyncRefreshPreparation<T>> {
    let active = this.inFlight;
    const shared = Boolean(active);

    if (!active) {
      const refreshPromise = options.refresh().finally(() => {
        if (this.inFlight === refreshPromise) {
          this.inFlight = undefined;
        }
      });
      active = refreshPromise;
      this.inFlight = refreshPromise;
    }

    if (
      options.staleWhileRevalidate &&
      typeof options.staleValue !== "undefined"
    ) {
      void active.catch(() => undefined);
      return {
        value: options.staleValue,
        mode: "background",
        shared,
      };
    }

    return {
      value: await active,
      mode: "blocking",
      shared,
    };
  }
}
