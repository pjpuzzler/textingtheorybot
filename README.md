# TextingTheory Bot

This Devvit app analyzes images of text conversations posted on r/TextingTheory. It uses Google Gemini for analysis, renders a stylized image of the chat, and posts a "Game Review" comment with the image and insights back to Reddit.

## Core Flow

1.  **New Post:** The app detects an image post on r/TextingTheory.
2.  **AI Analysis:** Image content is analyzed by Google Gemini.
3.  **Image Generation:** A Python script is run to create a stylized conversation image.
4.  **Final Comment:** The app picks up the rendered image and posts a full review comment to the original thread.

Also adds a menu item to submit your own custom analysis if the bot didn't get it quite right.

See it in action here (be warned, possible NSFW text messages): https://www.reddit.com/user/textingtheorybot/
