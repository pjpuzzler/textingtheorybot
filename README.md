# Texting Theory Bot

## App Overview

Texting Theory Bot is a Devvit app for community-driven analysis of text conversation screenshots. Users place chess-style badges on messages (for example: Brilliant, Best, Mistake, Blunder), and the community votes to produce consensus classifications and Elo-style ratings.

The app supports two post modes:

- **Vote mode**: creator places blank badge targets, community votes classifications + Elo.
- **Annotated mode**: creator places and sets classifications directly, then publishes a flattened image.

## Core User Experience

1. User opens **Create** entrypoint.
2. Uploads one or more screenshots (mode-dependent limits).
3. Places badges on messages and adjusts marker size.
4. Submits post to Reddit.
5. Viewers open post, vote per badge, and optionally submit/update Elo vote.
6. App computes consensus and updates post flair based on configured thresholds.

## Key Features

- Multi-image support for voting posts.
- Badge consensus using robust aggregation (IQM-based scoring).
- Elo voting with consensus display and flair updates.
- Eligibility checks to reduce low-quality or abusive voting.
- Creator restrictions (no self-voting).
- Unknown placeholder badge when consensus is not yet reached.

## Data & Storage

The app stores post analysis state and votes in Redis using post/user/badge scoped keys.

Stored data includes:

- Post metadata and badge placement coordinates.
- User badge votes and Elo votes.
- Consensus aggregates for rendering and flair logic.

The app does **not** require external third-party services for core functionality.

## Permissions Used

Configured in [devvit.json](devvit.json):

- `reddit` (submit posts, app/user Reddit API actions)
- `media` (upload image assets for posts)

## Safety & Abuse Controls

- Users cannot vote on their own posts.
- Voter eligibility checks include account age/karma thresholds.
- Best-effort banned-user filtering by subreddit.
- Book-sequence validation to prevent invalid chained Book votes.

## Flair Behavior

- Vote posts begin with a "No votes" flair.
- As votes accumulate, flair can update to Elo summary text (threshold-based).
- Annotated posts use an annotated flair template when submitted.
