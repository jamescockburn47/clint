/** Connection lifecycle: authentication loss degrades the channel, never the whole agent. */
export type ChannelStatus = 'starting' | 'connected' | 'reconnecting' | 'needs_pairing' | 'disabled' | 'stopped';
export class ChannelState {
  status: ChannelStatus = 'starting';
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly reconnect: () => Promise<void>, private readonly onError: (error: unknown) => void,
    private readonly delayMs = 5000) {}

  /** Update status and permit at most one reconnect attempt. */
  close(loggedOut: boolean): void {
    if (this.status === 'stopped' || this.status === 'disabled') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = loggedOut ? 'needs_pairing' : 'reconnecting';
    if (!loggedOut) this.timer = setTimeout(() => {
      this.timer = null;
      this.reconnect().catch(error => {
        this.onError(error);
        if (this.status === 'reconnecting') this.close(false);
      });
    }, this.delayMs);
  }

  /** Cancel obsolete retries on successful connection or shutdown. */
  set(status: ChannelStatus): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = status;
  }
}
