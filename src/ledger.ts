// "What left your device": every model call and network request Tripwire
// makes is recorded here, with the exact payload, so the user (and judges)
// can see the split between on-device and cloud.

export interface LedgerEntry {
  id: number;
  at: Date;
  where: 'device' | 'cloud';
  service: string;
  what: string;
  /** Characters sent (cloud) or read (device). */
  bytes: number;
  /** The exact text that was sent, or a description for device entries. */
  payload: string;
  direction?: 'out' | 'in';
  /** Personal details that were blanked before this left the device. */
  blanked?: number;
  /** Personal details found and kept on the device (device entries). */
  kept?: number;
  /** A request that was sent but refused. */
  rejected?: boolean;
}

type Listener = (entries: LedgerEntry[]) => void;

class Ledger {
  private entries: LedgerEntry[] = [];
  private listeners = new Set<Listener>();
  private next = 1;

  add(e: Omit<LedgerEntry, 'id' | 'at'>) {
    this.entries.push({ ...e, id: this.next++, at: new Date() });
    this.emit();
  }

  /** Start a fresh run but keep session-level entries (sign-in, config). */
  newRun() {
    this.entries = this.entries.filter((e) => e.service === 'Firebase Auth' || e.service === 'Remote Config');
    this.emit();
  }

  all() {
    return [...this.entries];
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.all());
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const snapshot = this.all();
    for (const fn of this.listeners) fn(snapshot);
  }
}

export const ledger = new Ledger();
