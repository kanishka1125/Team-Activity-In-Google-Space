import {
  goodMorningImages,
  type GoodMorningImagePicker,
} from "../../services/goodMorningImages.service.js";

// How long to wait for Google Chat to answer. Without a limit a stuck
// connection would keep the Team Activity / Good Morning check running
// forever and nothing else could be sent until a restart. A timeout is
// treated like any other failed send (kept as pending and retried).
export const GOOGLE_CHAT_TIMEOUT_MS = 15_000;

export class GoogleChatService {
  constructor(
    private readonly timeoutMs: number = GOOGLE_CHAT_TIMEOUT_MS,
    // Picks today's Good Morning picture (the rotation list, or
    // GOOD_MORNING_IMAGE_URL when there is no list).
    private readonly images: GoodMorningImagePicker = goodMorningImages,
  ) {}

  async sendTeamActivityMessage(
    message: string,
  ): Promise<void> {
    const webhookUrl =
      process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL;

    if (!webhookUrl) {
      throw new Error(
        "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is not configured",
      );
    }

    await this.sendMessage(webhookUrl, message);
  }

  async sendGoodMorningMessage(
    message: string,
  ): Promise<void> {
    const webhookUrl =
      process.env.GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL;

    if (!webhookUrl) {
      throw new Error(
        "GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL is not configured",
      );
    }

    // Throws "GOOD_MORNING_IMAGE_URL is not configured" when there is
    // neither a picture list nor the single picture setting. Picking does
    // not use the picture up; that happens only after a successful send.
    const choice = this.images.pick();

    const imageUrl = choice.url;

    await this.postJson(webhookUrl, {
      text: message,
      cardsV2: [
        {
          cardId: "good-morning",
          card: {
            sections: [
              {
                widgets: [
                  {
                    // Clicking the picture opens the full-size file.
                    image: {
                      imageUrl,
                      altText: "Good Morning Team",
                      onClick: {
                        openLink: { url: imageUrl },
                      },
                    },
                  },
                  {
                    // Chat cannot force a download, so the button
                    // opens the image where it can be saved.
                    buttonList: {
                      buttons: [
                        {
                          text: "Download image",
                          onClick: {
                            openLink: { url: imageUrl },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    // Google Chat accepted it: this picture is now used up.
    this.images.markSent(choice);
  }

  // Missing Timesheet report. Unlike the two methods above this never reads
  // GOOGLE_CHAT_TEAM_ACTIVITY_WEBHOOK_URL itself: the caller must pass the
  // webhook, already chosen and checked by config/missingTimesheetConfig.ts
  // (the testing Space, or the main Space only when explicitly enabled),
  // so it cannot post to the main Space by accident.
  async sendMissingTimesheetMessage(
    webhookUrl: string,
    message: string,
  ): Promise<void> {
    await this.sendMessage(webhookUrl, message);
  }

  private async sendMessage(
    webhookUrl: string,
    message: string,
  ): Promise<void> {
    await this.postJson(webhookUrl, { text: message });
  }

  // One place for the webhook POST, so both message types share the
  // same time limit and the same error text (the retry logic looks for
  // "429" in it).
  private async postJson(
    webhookUrl: string,
    payload: unknown,
  ): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json; charset=UTF-8",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `Google Chat webhook failed: ${response.status} ${errorText}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TimeoutError"
      ) {
        throw new Error(
          `Google Chat webhook did not respond within ${Math.round(this.timeoutMs / 1000)} seconds`,
        );
      }

      throw error;
    }
  }
}

export const googleChatService =
  new GoogleChatService();