import { createContext, useContext } from 'react'
import type { LanguageCode } from '../types'
import { translate, type TranslationKey } from './translations'

export interface I18nContextValue {
  language: LanguageCode
  t: (key: TranslationKey) => string
}

export const I18nContext = createContext<I18nContextValue>({
  language: 'ja',
  t: (key) => translate('ja', key),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
