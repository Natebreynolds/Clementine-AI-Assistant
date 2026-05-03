import { describe, expect, it } from 'vitest';
import { buildFeedSpec, recipeById, recipesForIntegration } from '../src/brain/connector-recipes.js';

describe('connector feed recipes', () => {
  it('exposes a generic tool-backed memory seed recipe for every connector', () => {
    const recipe = recipeById('tool-backed-memory-seed');

    expect(recipe?.integration).toBe('*');
    expect(recipe?.fields.map((f) => f.key)).toEqual([
      'topic',
      'toolName',
      'callGoal',
      'variablesJson',
      'recordStrategy',
      'slug',
      'limit',
    ]);
  });

  it('builds generic tool-backed prompts that call the selected tool and ingest deltas', () => {
    const recipe = recipeById('tool-backed-memory-seed');
    expect(recipe).toBeTruthy();

    const spec = buildFeedSpec(recipe!, {
      topic: 'hubspot contacts',
      toolName: 'mcp__hubspot__HUBSPOT_GET_CONTACTS',
      toolSourceName: 'hubspot',
      toolSourceKind: 'composio',
      toolSourceLabel: 'HubSpot',
      callGoal: 'Fetch contacts modified since the last run.',
      variablesJson: '{"limit":50,"properties":["email","lifecyclestage"]}',
      recordStrategy: 'One record per contact. Use email as the stable id.',
      limit: '50',
    });

    expect(spec.slug).toBe('tool-hubspot-hubspot-contacts');
    expect(spec.prompt).toContain('Call exactly this selected tool: `mcp__hubspot__HUBSPOT_GET_CONTACTS`');
    expect(spec.prompt).toContain('"limit":50');
    expect(spec.prompt).toContain('memory_recall');
    expect(spec.prompt).toContain('source:tool-hubspot-hubspot-contacts hubspot contacts HubSpot mcp__hubspot__HUBSPOT_GET_CONTACTS');
    expect(spec.prompt).toContain('brain_ingest_folder');
    expect(spec.prompt).toContain('toolSource:"composio"');
  });

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
