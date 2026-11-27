import { useState } from 'react'
import { Modal } from './Modal'
import { DotDotAppIcon, DotDotWordmark } from './DotDotBrand'
import { useI18n } from '../../i18n/I18nContext'

export type LegalDocTab = 'terms' | 'privacy' | 'license'

interface LegalDocsModalProps {
  open: boolean
  initialTab?: LegalDocTab
  onClose: () => void
}

const OSS_PACKAGES = [
  {
    name: 'React & React DOM',
    license: 'MIT License',
    copyright: 'Copyright (c) Meta Platforms, Inc. and affiliates.',
  },
  {
    name: 'React Router',
    license: 'MIT License',
    copyright: 'Copyright (c) Remix Software Inc.',
  },
  {
    name: 'Dexie.js',
    license: 'Apache License 2.0',
    copyright: 'Copyright (c) David Fahlander',
  },
  {
    name: 'fflate',
    license: 'MIT License',
    copyright: 'Copyright (c) Arjun Barrett',
  },
  {
    name: 'Motion',
    license: 'MIT License',
    copyright: 'Copyright (c) Motion Division',
  },
  {
    name: 'Tailwind CSS',
    license: 'MIT License',
    copyright: 'Copyright (c) Tailwind Labs, Inc.',
  },
  {
    name: 'Silkscreen (@fontsource/silkscreen)',
    license: 'SIL Open Font License 1.1 (OFL-1.1)',
    copyright: 'Copyright (c) Jason Kottke',
  },
  {
    name: 'DotGothic16 (@fontsource/dotgothic16)',
    license: 'SIL Open Font License 1.1 (OFL-1.1)',
    copyright: 'Copyright (c) Fontworks Inc.',
  },
] as const

export function LegalDocsModal({
  open,
  initialTab = 'terms',
  onClose,
}: LegalDocsModalProps) {
  const { t, language } = useI18n()
  const [tab, setTab] = useState<LegalDocTab>(initialTab)

  return (
    <Modal
      open={open}
      title={t('sectionLegal')}
      onClose={onClose}
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3" data-testid="legal-docs-modal">
        <div className="flex items-center gap-2.5 p-2.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)]">
          <DotDotAppIcon
            size={28}
            className="border-2 border-[var(--border-pixel)]"
          />
          <DotDotWordmark height={13} color="var(--accent-rose)" />
          <span className="ml-auto text-[11px] font-bold text-[var(--text-secondary)]">
            Pixel Art Studio
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => setTab('terms')}
            className={`min-h-[38px] px-2 text-xs font-bold ${
              tab === 'terms' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="legal-tab-terms"
          >
            {t('termsTitle')}
          </button>
          <button
            type="button"
            onClick={() => setTab('privacy')}
            className={`min-h-[38px] px-2 text-xs font-bold ${
              tab === 'privacy' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="legal-tab-privacy"
          >
            {t('privacyTitle')}
          </button>
          <button
            type="button"
            onClick={() => setTab('license')}
            className={`min-h-[38px] px-2 text-xs font-bold ${
              tab === 'license' ? 'pixel-btn pixel-btn-active' : 'pixel-btn'
            }`}
            data-testid="legal-tab-license"
          >
            {t('licenseTitle')}
          </button>
        </div>

        <div className="p-3.5 bg-[var(--bg-elevated)] border-2 border-[var(--border-pixel)] max-h-[60dvh] overflow-y-auto text-xs leading-relaxed space-y-3">
          {tab === 'terms' && (
            <div className="space-y-2.5" data-testid="legal-content-terms">
              {language === 'ja' ? (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    dotdot 利用規約
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>作品の権利帰属</strong>：本アプリ「dotdot」を用いて制作されたドット絵・アニメーション作品、ならびに書き出されたPNG・GIF・環境パックZIPの著作権および商用・非商用利用権は、すべて制作者ご本人に帰属します。
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>ローカル保存とバックアップ</strong>：本アプリはアカウント登録不要のオフライン対応Webアプリ（PWA）であり、作品データはご利用端末のブラウザ保存領域（IndexedDB）に保存されます。ブラウザのキャッシュ・サイトデータ消去や端末故障によるデータ消失を防ぐため、「環境パック (.zip)」による定期的なバックアップ書き出しを推奨します。
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>外部パレット（Lospec）の利用</strong>：Lospec公式APIから読み込んだパレットを利用する際は、各パレットの制作者表記・出典元を尊重してご利用ください。
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    4. <strong>免責事項</strong>：本アプリは現状有姿（AS-IS）で提供されます。ブラウザ仕様変更やストレージ上限等に起因するデータ消失・損害について、開発者は法令上許容される範囲で責任を負いません。
                  </p>
                </>
              ) : language === 'ko' ? (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    dotdot 이용약관
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>작품 권리 귀속</strong>: dotdot에서 제작한 모든 도트 그림·애니메이션 및 출력된 PNG·GIF 파일의 저작권과 상업적/비상업적 이용 권한은 전적으로 제작자 본인에게 귀속됩니다.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>로컬 저장 및 백업</strong>: 모든 데이터는 기기 내 브라우저 IndexedDB에 저장됩니다. 데이터 유실 방지를 위해 환경 팩(.zip) 정기 백업을 권장합니다.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>외부 팔레트(Lospec)</strong>: Lospec API로 불러온 팔레트는 원작자 및 출처 표기를 존중하여 사용해 주세요.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    4. <strong>면책 조항</strong>: 본 앱은 현상 그대로(AS-IS) 제공되며 브라우저 저장소 초기화 등으로 인한 데이터 손실에 대해 책임을 지지 않습니다.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    dotdot Terms of Service
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>Ownership of Artworks</strong>: You retain 100% ownership and commercial/non-commercial rights to all pixel art, animations, PNGs, GIFs, and Environment Packs created with dotdot.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>Local Storage & Backups</strong>: dotdot stores data locally inside your browser&apos;s IndexedDB without cloud accounts. Please export Environment Pack (.zip) backups regularly to guard against browser data clearing or device loss.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>Lospec Palettes</strong>: Palettes imported via the official Lospec API retain their respective creator attributions and source links locally.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    4. <strong>Disclaimer</strong>: This software is provided &quot;AS IS&quot; without warranties of any kind.
                  </p>
                </>
              )}
            </div>
          )}

          {tab === 'privacy' && (
            <div className="space-y-2.5" data-testid="legal-content-privacy">
              {language === 'ja' ? (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    プライバシーポリシー
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>作品データの外部送信なし</strong>：dotdot はローカルファースト設計です。制作中のキャンバス画素、レイヤー、タイムライン、パレット、Undo/Redo履歴、UI設定はすべてお使いの端末内の IndexedDB にのみ保存され、開発者のサーバーへ送信・収集されることはありません。
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>外部通信が発生する機能</strong>：お客様が明示的に「Lospec読込」を実行した場合に限り、指定されたパレットJSONを取得するため <code>https://lospec.com/palette-list/&lt;slug&gt;.json</code> へのHTTPSリクエストが行われます。取得後のパレットは端末内に保存され、オフラインでも利用できます。
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>トラッキング・広告なし</strong>：行動追跡Cookieや第三者広告SDKは一切使用していません。
                  </p>
                </>
              ) : language === 'ko' ? (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    개인정보처리방침
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>작품 데이터 외부 전송 없음</strong>: 모든 작품·레이어·프레임·팔레트·기록은 기기 내 IndexedDB에만 저장되며 외부 서버로 수집되지 않습니다.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>외부 네트워크 요청</strong>: 사용자가 직접 &quot;Lospec 불러오기&quot;를 실행할 때에만 <code>https://lospec.com</code> 공식 JSON API에 연결합니다.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>추적 및 광고 없음</strong>: 광고 SDK나 추적 쿠키를 사용하지 않습니다.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    Privacy Policy
                  </h3>
                  <p className="text-[var(--text-secondary)]">
                    1. <strong>Zero Cloud Collection</strong>: All artworks, cels, layers, palettes, settings, and Undo/Redo histories remain strictly inside your browser&apos;s local IndexedDB. We do not upload or collect your artwork on any server.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    2. <strong>Optional Network Requests</strong>: Network requests occur only when you explicitly fetch a palette from <code>https://lospec.com/palette-list/&lt;slug&gt;.json</code>. Once imported, palettes are stored locally for offline use.
                  </p>
                  <p className="text-[var(--text-secondary)]">
                    3. <strong>No Analytics or Ads</strong>: dotdot contains no third-party ad trackers or behavioral analytics cookies.
                  </p>
                </>
              )}
            </div>
          )}

          {tab === 'license' && (
            <div className="space-y-2.5" data-testid="legal-content-license">
              <div className="space-y-1">
                <h3 className="font-bold text-sm text-[var(--text-primary)]">
                  dotdot Source Code &amp; Open Source Licenses
                </h3>
                <p className="text-[var(--text-secondary)]">
                  Repository:{' '}
                  <a
                    href="https://github.com/shaboten26/dotdot"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-[var(--accent-teal)]"
                  >
                    https://github.com/shaboten26/dotdot
                  </a>
                </p>
              </div>

              <div className="space-y-2 pt-1">
                {OSS_PACKAGES.map((pkg) => (
                  <div
                    key={pkg.name}
                    className="p-2 bg-[var(--bg-surface)] border border-[var(--border-pixel)] space-y-0.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[var(--text-primary)]">
                        {pkg.name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-elevated)] border border-[var(--border-pixel)] font-mono">
                        {pkg.license}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      {pkg.copyright}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="pixel-btn pixel-btn-active min-h-[38px] px-4 text-xs font-bold"
            data-testid="legal-close-btn"
          >
            {t('close')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
