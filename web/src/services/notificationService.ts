export interface NotificationPreferences {
  enabled: boolean;
  onComplete: boolean;
  onFailure: boolean;
}

type NotificationEvent = 'run:completed' | 'run:failed';
type NotificationCallback = (...args: any[]) => void;

export class NotificationService {
  private preferences: NotificationPreferences = {
    enabled: true,
    onComplete: true,
    onFailure: true
  };
  private listeners: Map<NotificationEvent, NotificationCallback[]> = new Map();

  setPreferences(prefs: Partial<NotificationPreferences>): void {
    this.preferences = { ...this.preferences, ...prefs };
  }

  getPreferences(): NotificationPreferences {
    return { ...this.preferences };
  }

  on(event: NotificationEvent, callback: NotificationCallback): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  emit(event: NotificationEvent, ...args: any[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  async requestPermission(): Promise<boolean> {
    if (!("Notification" in window)) {
      console.warn("This browser does not support desktop notification");
      return false;
    }
    if (Notification.permission === "granted") {
      return true;
    }
    if (Notification.permission !== "denied") {
      const permission = await Notification.requestPermission();
      return permission === "granted";
    }
    return false;
  }

  async notifyRunComplete(runName: string): Promise<void> {
    if (!this.preferences.enabled || !this.preferences.onComplete) return;
    const granted = await this.requestPermission();
    if (!granted) return;
    new Notification("Run Complete", {
      body: `The run "${runName}" has completed successfully.`,
      icon: "/favicon.ico"
    });
  }

  async notifyRunFailed(runName: string, error?: string): Promise<void> {
    if (!this.preferences.enabled || !this.preferences.onFailure) return;
    const granted = await this.requestPermission();
    if (!granted) return;
    new Notification("Run Failed", {
      body: `The run "${runName}" has failed.${error ? ` Error: ${error}` : ""}`,
      icon: "/favicon.ico"
    });
  }
}

// Singleton instance for convenience
export const notificationService = new NotificationService();
