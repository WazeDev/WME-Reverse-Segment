# WME Reverse Segment

A [Waze Map Editor (WME)](https://www.waze.com/editor) userscript that reverses the A/B direction of a segment. The geometry is flipped and all direction-dependent attributes are swapped, so the road itself stays exactly the same.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/).
2. Install `wme-reverse-segment.js` in the userscript manager.
3. Open WME. The script loads automatically and requires [WazeWrap](https://greasyfork.org/scripts/24851-wazewrap).

## Usage

Select a single segment and click **Flip A/B** in the segment panel (below the level selection), or press **Alt+R**. The whole reverse is one undo step.

If the segment can't be reversed, the button is disabled and the reason is shown next to it. Pressing the shortcut shows the reason as a notification.

## What Is Kept

| Attribute                       | After reverse                                                         |
| ------------------------------- | --------------------------------------------------------------------- |
| Direction (one-way)             | A→B becomes B→A and vice versa                                        |
| Speed limits                    | Forward and reverse values swapped                                    |
| Lanes and lane guidance         | Moved to the matching direction                                       |
| Allowed turns                   | Restored, including turn restrictions                                 |
| Turn guidance                   | TTS, road shields, exit signs, towards and visual instructions        |
| Traffic lights / speed cameras  | Same position, flipped direction, including traffic light guidance    |

If anything could not be restored, a warning is shown so you can check the turns or undo.

## Limitations

A segment can't be reversed if it

- is part of a big junction,
- has closures, or is connected to a segment with closures,
- or one of the segments connected to it can't be fully edited by you (e.g. lock level).

## Keyboard Shortcut

| Default Key | Action                           | WME Shortcut Name                |
| ----------- | -------------------------------- | -------------------------------- |
| **Alt+R**   | Flip A/B of the selected segment | Flip A/B of the selected segment |

The shortcut can be changed in the WME keyboard shortcuts dialog (**WME Reverse Segment**). Changes are saved in `localStorage` under the key `wme-reverse-segment`.

## License

[MIT](LICENSE)
