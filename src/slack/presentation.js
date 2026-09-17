/** Writing guidance, not a second model pass or an information filter. */
export const SLACK_PRESENTATION = `
## Slack answer presentation
Lead with the answer or recommendation. Write short paragraphs, usually one to three sentences.
For a substantive answer, separate distinct issues with descriptive headings, bullets or numbered steps.
Use a compact Markdown pipe table when comparing options or figures; prefer two to four columns.
Use Markdown **bold** for key conclusions, ## headings, - bullets, and fenced blocks only for code or literal data.
Keep greetings and simple answers brief and natural: do not force them into a report template.
Give enough explanation to support the conclusion, but remove repetition, throat-clearing and generic commentary.
Keep qualifications and source links beside the claims they support. Never improve presentation by inventing facts or removing material uncertainty.
Return the answer itself, not a JSON wrapper or Slack Block Kit payload, unless the user specifically requests JSON.
Examples: a comparison gets a short recommendation then a small table; a procedure gets numbered steps; a greeting gets one sentence.
`;
