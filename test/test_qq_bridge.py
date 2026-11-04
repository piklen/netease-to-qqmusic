"""桥接器纯函数测试：不连接 QQ、不使用任何账号凭据。"""

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from src.py.qq_bridge import PROTOCOL_VERSION, SEARCH_TYPES, strip_tags, render_terminal_qr, emit
from qqmusic_api.modules.search import SearchType


class BridgeUnitTests(unittest.TestCase):
    def test_protocol_version_is_declared(self):
        self.assertEqual(PROTOCOL_VERSION, 2)

    def test_search_type_mapping_matches_node_contract(self):
        self.assertEqual(SEARCH_TYPES[0], SearchType.SONG)
        self.assertEqual(SEARCH_TYPES[8], SearchType.ALBUM)
        self.assertEqual(SEARCH_TYPES[9], SearchType.SINGER)

    def test_highlight_tags_stripped_from_names(self):
        self.assertEqual(strip_tags("周<em>杰</em>伦"), "周杰伦")
        self.assertEqual(strip_tags(None), "")

    def test_terminal_qr_uses_half_blocks_and_fixed_width(self):
        image = Image.new("1", (8, 8), 1)
        rendered = render_terminal_qr(image)
        lines = rendered.splitlines()
        self.assertEqual(len(lines), 4)
        self.assertTrue(all(len(line) == 8 for line in lines))
        self.assertTrue(set(rendered.replace("\n", "")) <= {" ", "▀", "▄", "█"})

    def test_emit_writes_single_json_line(self):
        import io
        from contextlib import redirect_stdout
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            emit({"ok": True, "结果": "中文"})
        output = buffer.getvalue().strip()
        self.assertEqual(output.count("\n"), 0)
        self.assertEqual(json.loads(output)["结果"], "中文")


if __name__ == "__main__":
    unittest.main()
