/**
 * Gemini API integration for AI subtitle generation.
 * Uses Gemini 3 Flash Preview to generate contextual SRT subtitles.
 */

const fetch = require('node-fetch');
const config = require('./config');

/**
 * Build the prompt for subtitle generation
 */
function buildSubtitlePrompt(title, type, lang, season, episode) {
  const langInfo = config.SUPPORTED_LANGUAGES.find(l => l.code === lang);
  const langName = langInfo ? langInfo.name : 'English';
  const langDisplay = langInfo ? langInfo.displayName : 'English';

  let contentDesc = '';
  if (type === 'series' && season && episode) {
    contentDesc = `TV Series: "${title}" - Season ${season}, Episode ${episode}`;
  } else if (type === 'series') {
    contentDesc = `TV Series: "${title}"`;
  } else {
    contentDesc = `Movie: "${title}"`;
  }

  return `You are a professional subtitle creator. Generate realistic, high-quality subtitles in SRT format for the following content:

${contentDesc}

Requirements:
1. Write the subtitles in ${langName} (${langDisplay})
2. Output ONLY valid SRT format - no markdown, no code blocks, no explanations
3. Generate approximately 40-60 subtitle entries spanning a realistic duration (about 90 minutes for movies, 45 minutes for series episodes)
4. Include realistic dialogue, narration cues, and scene descriptions in brackets like [music playing] or [door closes]
5. Use proper SRT timestamp format: HH:MM:SS,mmm --> HH:MM:SS,mmm
6. Make the dialogue contextually relevant to a ${type} titled "${title}"
7. Start with subtitle number 1 and increment sequentially
8. Each subtitle entry should be separated by a blank line
9. Keep individual subtitle text to maximum 2 lines, about 42 characters per line
10. Ensure timestamps are sequential and realistic (2-5 seconds per subtitle)

Example format:
1
00:00:01,000 --> 00:00:04,500
[dramatic music playing]

2
00:00:05,000 --> 00:00:08,200
First line of dialogue here.

Begin generating the SRT subtitles now:`;
}

/**
 * Call the Gemini API to generate subtitles
 * @param {string} title - Content title
 * @param {string} type - 'movie' or 'series'
 * @param {string} lang - Language code (e.g., 'heb', 'eng')
 * @param {string|null} season - Season number for series
 * @param {string|null} episode - Episode number for series
 * @returns {Promise<string>} SRT formatted subtitle text
 */
async function generateSubtitles(title, type, lang, season, episode) {
  const prompt = buildSubtitlePrompt(title, type, lang, season, episode);
  const url = `${config.GEMINI_API_URL}/${config.GEMINI_MODEL}:generateContent`;

  console.log(`[Gemini] Generating subtitles for "${title}" (${type}) in ${lang}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          topP: 0.95,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Gemini] API Error ${response.status}: ${errorText}`);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error('[Gemini] Invalid response structure:', JSON.stringify(data).slice(0, 500));
      throw new Error('Invalid Gemini response structure');
    }

    let srtText = data.candidates[0].content.parts[0].text;

    // Clean up: remove markdown code fences if present
    srtText = srtText.replace(/^```(?:srt)?\s*\n?/gm, '');
    srtText = srtText.replace(/\n?```\s*$/gm, '');
    srtText = srtText.trim();

    // Validate basic SRT structure
    if (!/^\d+\s*\n\d{2}:\d{2}:\d{2}/m.test(srtText)) {
      console.warn('[Gemini] Generated text may not be valid SRT format');
    }

    console.log(`[Gemini] ✅ Generated ${srtText.split('\n\n').length} subtitle entries for "${title}" in ${lang}`);
    return srtText;

  } catch (error) {
    console.error(`[Gemini] Failed to generate subtitles: ${error.message}`);
    throw error;
  }
}

module.exports = { generateSubtitles };
