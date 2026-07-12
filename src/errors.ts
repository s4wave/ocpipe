/** ocpipe typed runtime errors. */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${bytes / (1024 * 1024 * 1024)} GiB`
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`
  if (bytes >= 1024) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}

/** OutputLimitError reports a bounded output buffer or file limit breach. */
export class OutputLimitError extends Error {
  constructor(
    public readonly source: string,
    public readonly limitBytes: number,
  ) {
    super(`${source} exceeded ${formatBytes(limitBytes)} limit`)
    this.name = 'OutputLimitError'
  }
}
