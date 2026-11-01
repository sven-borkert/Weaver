export class PdfBusyError extends Error {
  constructor() {
    super("PDF export is busy; try again in a few seconds");
  }
}

export function createLimiter(options: {
  concurrency: number;
  maxWaiting: number;
}) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= options.concurrency) return;
    queue.shift()?.();
  };
  return {
    get waiting() {
      return queue.length;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= options.concurrency && queue.length >= options.maxWaiting)
        return Promise.reject(new PdfBusyError());
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active += 1;
          task()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        };
        if (active < options.concurrency) start();
        else queue.push(start);
      });
    },
  };
}
