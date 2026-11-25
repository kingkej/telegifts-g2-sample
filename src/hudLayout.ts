import {
  ImageContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk'
import { fitNativeText, nativeMenuLabel, nativeTextBytes } from './displayText.ts'
import { frameHeight, frameWidth } from './inspection.ts'

export const artworkSize = 120
export const imageContainer = { containerID: 2, containerName: 'artwork' }

export interface HudRegions {
  header?: string
  body: string
  footer?: string
}

export interface HudTargetIds {
  body: { containerID: number; containerName: string }
  header: { containerID: number; containerName: string }
  footer: { containerID: number; containerName: string }
  menu: ReadonlyMap<number, string | { id: string; label: string }>
}

/**
 * Builds an Even Hub SDK 0.0.16 page layout for the 576 x 288 monochrome G2 display.
 *
 * Supports both:
 *  - Single-pane mode (1 primary capture container + optional artwork/frame)
 *  - Multi-region spatial HUD mode (3 brightness-graded text containers:
 *      zOrderIndex 1: muted header chrome at textColor 2,
 *      zOrderIndex 2: focal readout at textColor 4 with isEventCapture: 1,
 *      zOrderIndex 3: action bar at textColor 3,
 *      plus optional zOrderIndex 4 image container)
 *
 * Always keeps `textObject[0]` as the unique `isEventCapture: 1` focal region and
 * validates container rules (`validateEvenHubPageContainer`) before returning.
 */
export function buildHudContainers(opts: {
  content: string
  regions?: HudRegions
  withArtwork: boolean
  largeFrame: boolean
  target: HudTargetIds
}) {
  const { content, regions, withArtwork, largeFrame, target } = opts
  const menuObject = target.menu.size
    ? new MenuContainerProperty({
        menuItems: Array.from(target.menu, ([itemID, item]) =>
          new MenuItemProperty({
            itemID,
            itemName: nativeMenuLabel(typeof item === 'string' ? item : item.label),
          }),
        ),
      })
    : undefined

  if (regions && (regions.header || regions.footer)) {
    const bodyWidth = withArtwork ? (largeFrame ? 286 : 424) : 560
    const textObject: TextContainerProperty[] = [
      new TextContainerProperty({
        ...target.body,
        xPosition: 8,
        yPosition: regions.header ? 38 : 6,
        width: bodyWidth,
        height: regions.header && regions.footer ? 196 : regions.header || regions.footer ? 232 : 276,
        paddingLength: 6,
        isEventCapture: 1,
        zOrderIndex: 2,
        textColor: 4,
        content: fitNativeText(regions.body, nativeTextBytes),
      }),
    ]
    if (regions.header) {
      textObject.push(
        new TextContainerProperty({
          ...target.header,
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 30,
          paddingLength: 4,
          isEventCapture: 0,
          zOrderIndex: 1,
          textColor: 2,
          content: fitNativeText(regions.header, 240),
        }),
      )
    }
    if (regions.footer) {
      textObject.push(
        new TextContainerProperty({
          ...target.footer,
          xPosition: 8,
          yPosition: 238,
          width: 560,
          height: 44,
          paddingLength: 4,
          isEventCapture: 0,
          zOrderIndex: 3,
          textColor: 3,
          content: fitNativeText(regions.footer, 240),
        }),
      )
    }
    const imageObject = withArtwork
      ? [
          new ImageContainerProperty({
            ...imageContainer,
            xPosition: largeFrame ? 304 : 440,
            yPosition: largeFrame ? 56 : 42,
            width: largeFrame ? frameWidth : artworkSize,
            height: largeFrame ? frameHeight : artworkSize,
            zOrderIndex: 4,
          }),
        ]
      : []

    const payload = {
      containerTotalNum: textObject.length + imageObject.length,
      menuObject,
      textObject,
      imageObject,
    }
    const check = validateEvenHubPageContainer(payload)
    if (!check.valid) throw new Error(`Invalid G2 multi-container HUD: ${check.message}`)
    return payload
  }

  const payload = {
    containerTotalNum: withArtwork ? 2 : 1,
    menuObject,
    textObject: [
      new TextContainerProperty({
        ...target.body,
        xPosition: 8,
        yPosition: 6,
        width: withArtwork ? (largeFrame ? 286 : 424) : 560,
        height: 276,
        paddingLength: 8,
        isEventCapture: 1,
        content,
      }),
    ],
    imageObject: withArtwork
      ? [
          new ImageContainerProperty({
            ...imageContainer,
            xPosition: largeFrame ? 304 : 440,
            yPosition: largeFrame ? 64 : 36,
            width: largeFrame ? frameWidth : artworkSize,
            height: largeFrame ? frameHeight : artworkSize,
          }),
        ]
      : [],
  }
  const check = validateEvenHubPageContainer(payload)
  if (!check.valid) throw new Error(`Invalid G2 container layout: ${check.message}`)
  return payload
}
