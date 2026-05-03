import { describe, expect, it } from 'vitest';
import { buildFeedSpec, recipeById, recipesForIntegration } from '../src/brain/connector-recipes.js';

describe('connector feed recipes', () => {
  it('exposes a Composio Google Sheets seed recipe', () => {
    const recipes = recipesForIntegration('googlesheets');
    const recipe = recipeById('googlesheets-range');

    expect(recipes.map((r) => r.id)).toContain('googlesheets-range');
    expect(recipe?.integration).toBe('googlesheets');
  });

  it('builds Google Sheets feed prompts that recall existing memory before ingesting', () => {
    const recipe = recipeById('googlesheets-range');
    expect(recipe).toBeTruthy();

    const spec = buildFeedSpec(recipe!, {
      spreadsheet: 'https://docs.google.com/spreadsheets/d/sheet123/edit',
      range: 'Customers!A:Z',
      topic: 'customer intelligence',
      keyColumn: 'email',
      limit: '250',
    });

    expect(spec.slug).toBe('gsheet-customer-intelligence');
    expect(spec.targetFolder).toBe('04-Ingest/gsheet-customer-intelligence');
    expect(spec.prompt).toContain('mcp__googlesheets__*');
    expect(spec.prompt).toContain('memory_recall');
    expect(spec.prompt).toContain('source:gsheet-customer-intelligence customer intelligence Google Sheet Customers!A:Z');
    expect(spec.prompt).toContain('brain_ingest_folder');
    expect(spec.prompt).toContain('toolSource:"composio"');
  });
});
