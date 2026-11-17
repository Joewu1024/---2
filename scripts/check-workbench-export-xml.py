"""Independent stdlib ZIP/strict XML readback of fabricated Node export fixtures.

Run check-workbench-export.cjs PATH/worker-test-export.xlsx first, then pass that
same path here. No user workbooks, credentials, browser storage or network used.
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read(path):
    assert 'test' in path.name.lower(), 'Only explicitly named test fixtures are accepted'
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == 5
        xml = {name: ET.fromstring(archive.read(name)) for name in archive.namelist()}
    sheet = xml['xl/worksheets/sheet1.xml']
    rows = sheet.findall('s:sheetData/s:row', NS)
    all_cells = sheet.findall('.//s:c', NS)
    assert all(cell.attrib['t'] == 'inlineStr' for cell in all_cells)
    for cell in all_cells:
        text = ''.join(cell.itertext())
        assert len(text.encode('utf-16-le')) // 2 <= 32767
    return rows, all_cells


destination = Path(sys.argv[1]).resolve()
rows, cells = read(destination)
assert len(rows) == 20001 and len(cells) == 240012
assert rows[1][0].find('s:is/s:t', NS).text == '900719925474099312345'
assert rows[-1][0].find('s:is/s:t', NS).text == str(900719925474099312345 + 19999)
assert rows[1][7].find('s:is/s:t', NS).text == '0000000000000000'
assert '\n' in rows[1][6].find('s:is/s:t', NS).text

edge_rows, edge_cells = read(destination.with_name(destination.stem + '-edges.xlsx'))
assert len(edge_rows) == 2 and len(edge_cells) == 18
assert edge_rows[1][5].find('s:is/s:t', NS).text == 'xyz'
assert len(edge_rows[1][6].find('s:is/s:t', NS).text) == 32767
assert len(edge_rows[1][7].find('s:is/s:t', NS).text) == 32766
assert edge_rows[1][8].find('s:is/s:t', NS).text == '中文 😀 𠀀\nsecond line'
print(json.dumps({'fabricated_only': True, 'strict_xml_documents': 10,
                  'bulk_data_rows': len(rows) - 1, 'bulk_cells': len(cells),
                  'all_cells_text': True, 'zip_crc_verified': True,
                  'xml_controls_surrogates_and_utf16_limit_verified': True}))
