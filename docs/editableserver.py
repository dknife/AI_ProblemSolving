# -*- coding: utf-8 -*-
"""AI 문제해결 웹 에디션 — 편집 가능한 로컬 서버.

index.html 옆에서 그냥 이렇게 띄운다.

    python editableserver.py                # 알아서 판단해 빌드하고 서빙
    python editableserver.py --port 8080
    python editableserver.py --no-build     # 무조건 직전 빌드 재사용
    python editableserver.py --build        # 무조건 다시 빌드

떠 있는 동안 브라우저에서 Ctrl+E(맥 ⌘E)를 누르면 편집 모드가 켜지고,
문단·목록·제목을 HTML로 고쳐 저장하면 원고 .tex에 그대로 반영된다.

이 파일은 실행기일 뿐이고, 실제 구현은 원고 폴더의 WebBook/에 있다
(editserver.py · html2tex.py · tex2html.py). 원고와 변환기는 한 몸이라
원고 폴더에 두는 것이 맞고, 여기에는 "어디서 띄우는가"만 둔다.

원고 폴더를 못 찾으면 환경변수로 알려 주면 된다.

    AIPS_WEBBOOK=/경로/AI활용_문제해결/WebBook python editableserver.py
"""
import os
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
REPO = DOCS.parent


def find_webbook():
    """변환기가 있는 WebBook 폴더를 찾는다."""
    env = os.environ.get("AIPS_WEBBOOK")
    if env:
        p = Path(env).expanduser()
        if (p / "editserver.py").exists():
            return p
        sys.exit("AIPS_WEBBOOK이 가리키는 곳에 editserver.py가 없습니다: %s" % p)

    cands = []
    # 원고 폴더가 이 저장소 옆에 있는 경우
    cands += [REPO.parent / "AI활용_문제해결" / "WebBook",
              REPO / ".." / "WebBook"]
    # 원드라이브에 있는 경우 (계정 폴더 이름이 기기마다 달라 글롭으로 찾는다)
    home = Path.home()
    cands += sorted(home.glob(
        "Library/CloudStorage/OneDrive*/*/YMKang_Work/저술_원고/"
        "AI활용_문제해결/WebBook"))
    cands += sorted(home.glob("*/YMKang_Work/저술_원고/AI활용_문제해결/WebBook"))

    for p in cands:
        try:
            if (p / "editserver.py").exists():
                return p.resolve()
        except OSError:
            continue
    sys.exit(
        "원고 폴더(WebBook)를 찾지 못했습니다.\n"
        "환경변수로 알려 주세요:\n\n"
        "  AIPS_WEBBOOK=/경로/AI활용_문제해결/WebBook "
        "python editableserver.py\n")


def needs_build(webbook):
    """원고가 직전 빌드 이후에 바뀌었으면 True.

    바뀐 원고를 두고 옛 blocks.json으로 편집하면 저장이 거부되므로
    (내용이 안 맞으면 서버가 물러난다) 여기서 미리 가려낸다.
    """
    blocks = webbook / "blocks.json"
    if not blocks.exists():
        return True
    latest = blocks.stat().st_mtime
    tex = webbook.parent / "latex"
    for f in tex.rglob("*.tex"):
        if f.stat().st_mtime > latest:
            print("  원고가 바뀌었습니다: %s" % f.relative_to(tex))
            return True
    return False


def main():
    webbook = find_webbook()
    # editserver/tex2html이 내보낼 곳 = 바로 이 docs 폴더의 저장소
    os.environ["AIPS_REPO"] = str(REPO)
    sys.path.insert(0, str(webbook))

    argv = sys.argv[1:]
    force_build = "--build" in argv
    argv = [a for a in argv if a != "--build"]
    if not force_build and "--no-build" not in argv:
        print("원고 변경 확인 중...")
        if needs_build(webbook):
            print("  → 다시 빌드합니다 (1분쯤 걸립니다)")
        else:
            print("  → 직전 빌드를 그대로 씁니다")
            argv.append("--no-build")
    sys.argv = [sys.argv[0]] + argv

    print("웹 문서: %s" % DOCS)

    import editserver
    editserver.main()


if __name__ == "__main__":
    main()
