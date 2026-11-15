// Types of what we use from `web-push` 3.6.7 (the package ships none).
declare module "web-push" {
  interface RequestDetails {
    method: string;
    headers: Record<string, string | number>;
    body: Uint8Array | null;
    endpoint: string;
  }
  interface WebPush {
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
    generateRequestDetails(
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
      payload: string,
      options: {
        vapidDetails: { subject: string; publicKey: string; privateKey: string };
        TTL?: number;
        urgency?: "very-low" | "low" | "normal" | "high";
        topic?: string;
      },
    ): RequestDetails;
  }
  const webpush: WebPush;
  export default webpush;
}
