# Review brief — lite window Q-0103 (Telegram job card shows the outcome on its face)

Facts: `telegramJobNotificationMessage` placed `result.headline` as the first line INSIDE `<blockquote expandable>`, so the run's outcome sentence was collapsed behind a tap while the tool tally was the visible content. Slack (bold section) and Discord (embed description) already show it on the face.

Contract for this diff: the headline renders as its own bold line immediately after the status line, outside the blockquote; the blockquote keeps the per-tool items and Next action; the stats and Next run lines are unchanged. Entity-safe truncation reused if needed.

Focus: HTML escaping of the headline, message-length safety, and no duplicate headline inside the quote. Ignore style.
