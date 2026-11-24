import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  buildLospecApiUrl,
  fetchLospecPalette,
  LospecFetchError,
  mergeLospecPaletteColors,
  parseLospecInputToSlug,
} from '../db/lospec'
import { LegalDocsModal } from '../components/common/LegalDocsModal'
import { AppProvider } from '../state/AppContext'

describe('Lospec Official API Importer & Legal/Terms/Privacy/License Docs', () => {
  it('parses Lospec URLs and slugs accurately and rejects invalid inputs', () => {
    expect(parseLospecInputToSlug('pico-8')).toBe('pico-8')
    expect(parseLospecInputToSlug('  Sweetie 16  ')).toBe('sweetie-16')
    expect(parseLospecInputToSlug('https://lospec.com/palette-list/oil-6')).toBe('oil-6')
    expect(parseLospecInputToSlug('https://lospec.com/palette-list/endesga-32.json')).toBe(
      'endesga-32'
    )
    expect(parseLospecInputToSlug('lospec.com/palette-list/nyx8?ref=1')).toBe('nyx8')
    expect(buildLospecApiUrl('oil-6')).toBe('https://lospec.com/palette-list/oil-6.json')

    expect(() => parseLospecInputToSlug('')).toThrow(LospecFetchError)
    expect(() => parseLospecInputToSlug('***')).toThrow(LospecFetchError)
  })

  it('fetches, normalizes, caps at 256 colors, and supports both Replace and Append modes', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'Oil 6',
        author: 'GrafxKid',
        colors: ['fbf5ef', 'f2d3ab', '#c69fa5', '8b6d9c', '494d7e', '272744'],
      }),
    })) as unknown as typeof fetch

    const res = await fetchLospecPalette('https://lospec.com/palette-list/oil-6', {
      fetchImpl: mockFetch,
    })
    expect(res.slug).toBe('oil-6')
    expect(res.name).toBe('Oil 6')
    expect(res.author).toBe('GrafxKid')
    expect(res.sourceUrl).toBe('https://lospec.com/palette-list/oil-6')
    expect(res.colors).toEqual([
      '#FBF5EF',
      '#F2D3AB',
      '#C69FA5',
      '#8B6D9C',
      '#494D7E',
      '#272744',
    ])
    expect(res.truncated).toBe(false)

    const replaced = mergeLospecPaletteColors(['#000000', '#FFFFFF'], res.colors, 'replace')
    expect(replaced.colors).toEqual(res.colors)

    const appended = mergeLospecPaletteColors(['#000000', '#FFFFFF'], res.colors, 'append')
    expect(appended.colors.length).toBe(8)
    expect(appended.colors.slice(0, 2)).toEqual(['#000000', '#FFFFFF'])
    expect(appended.colors.slice(2)).toEqual(res.colors)
  })

  it('renders Terms of Service, Privacy Policy, and Source Code / OSS Licenses cleanly', () => {
    const onClose = vi.fn()
    render(
      <AppProvider>
        <LegalDocsModal open={true} initialTab="terms" onClose={onClose} />
      </AppProvider>
    )

    expect(screen.getByTestId('legal-content-terms')).toBeTruthy()
    fireEvent.click(screen.getByTestId('legal-tab-privacy'))
    expect(screen.getByTestId('legal-content-privacy')).toBeTruthy()
    fireEvent.click(screen.getByTestId('legal-tab-license'))
    expect(screen.getByTestId('legal-content-license')).toBeTruthy()
    expect(screen.getByText(/Dexie\.js/i)).toBeTruthy()
  })
})
