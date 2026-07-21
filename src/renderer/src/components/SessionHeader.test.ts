import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { useChatStore } from '../store/chat-store'
import { SessionHeader } from './SessionHeader'

const initialChatState = useChatStore.getState()

describe('SessionHeader', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useChatStore.setState({
      ...initialChatState,
      workspaceLabel: 'Working directory',
      activeThreadId: 'thread-1',
      blocks: [
        { kind: 'user', id: 'user-1', turnId: 'turn-1', text: 'Question' },
        { kind: 'assistant', id: 'assistant-1', turnId: 'turn-1', text: 'Answer' }
      ],
      threads: [{
        id: 'thread-1',
        title: 'Fix drag region',
        updatedAt: '2026-06-10T10:00:00.000Z',
        model: 'deepseek-chat',
        mode: 'chat',
        workspace: '/workspace/deepseek-gui'
      }]
    })
  })

  afterEach(() => {
    useChatStore.setState(initialChatState)
  })

  it('keeps the compact session title area draggable in desktop shells', () => {
    let renderer: ReactTestRenderer
    act(() => {
      renderer = createRenderer(createElement(SessionHeader, { compact: true }))
    })
    const html = JSON.stringify(renderer!.toJSON())

    expect(html).toContain('session-header-compact flex')
    expect(html).not.toContain('session-header-compact ds-no-drag')
    expect(html).toContain('ds-no-drag relative shrink-0')
    expect(html).toContain('"aria-label":"Export conversation"')
    expect(html).toContain('deepseek-gui')
    act(() => renderer!.unmount())
  })
})
