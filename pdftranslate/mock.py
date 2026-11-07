"""离线用的假数据，方便在没有 API Key 的情况下验证排版与输出。"""

from __future__ import annotations

from .vision import Block, PageResult

PAGE_1 = [
    ('annotation', 'A-83-001_2-1', '档案编号 A-83-001_2-1'),
    ('header', 'BL 11-23-70', 'BL 11-23-70（手写批注）'),
    (
        'addressee',
        'Dear Mr. Tuck:',
        '塔克先生：',
    ),
    (
        'paragraph',
        'I am sorry that I cannot fill out the attached form since the time and dates of any sightings escape me.',
        '很抱歉，我无法填写所附表格，因为那些目击的时间和日期我已经记不清了。',
    ),
    (
        'paragraph',
        'I can, however, tell you that during the years 1948 through 1951 several sightings of green lights were made at Los Alamos. These usually occurred during the early part of the night, nine to eleven, and were usually in the Jemez Mountains.',
        '不过我可以告诉你，1948 至 1951 年间，在洛斯阿拉莫斯（Los Alamos）有过数次绿光目击记录。这些目击通常发生在上半夜九点到十一点之间，且多在赫梅斯山（Jemez Mountains）一带。',
    ),
    (
        'paragraph',
        'I can recall several instances of green lights moving in and out of mountain peaks. This was all reported to the Protective Force Headquarters and should be a matter of record in their logs.',
        '我能记起几次绿光在山峰间进出移动的情形。这些情况当时都上报给了保卫部队司令部，应当在他们 的记录中有案可查。',
    ),
    (
        'paragraph',
        'I also recall one instance of five objects flying over Los Alamos in the afternoon. They were flying from southwest to northeast and appeared to be flying in formation. I believe [涂黑 (b)(6)] of the Protective Force was one of the few on post people that',
        '我还记得有一次，五个物体在下午飞越洛斯阿拉莫斯上空。它们由西南向东北飞行，看来是编队飞行。我相信 [涂黑 (b)(6)] 是当时在岗的少数几人之一，他',
    ),
]


def mock_page(page_no: int) -> PageResult:
    if page_no == 1:
        blocks = [Block(kind=k, original=o, translation=t) for k, o, t in PAGE_1]
    elif page_no == 3:
        blocks = [
            Block('annotation', 'P-DO', 'P-DO（打印编号）'),
            Block('date', '16 December 1970', '1970 年 12 月 16 日'),
            Block('redaction', '[涂黑 (b)(6)]', '[涂黑 (b)(6)]'),
            Block('addressee', 'U. S. Army Engineering School\nFort Belvoir, Virginia 22060', '美国陆军工程学校\n弗吉尼亚州贝尔沃堡，邮编 22060'),
            Block('addressee', 'Attention: Department of Mechanical and Technical Equipment', '收件人：机械与技术装备系'),
            Block('addressee', 'Dear [涂黑 (b)(6)],', '[涂黑 (b)(6)] 先生：'),
            Block(
                'paragraph',
                'As agreed in our telephone conversation of today\'s date, I would like to have the recipe that was used for the simulated atomic bomb demonstrations.',
                '按照我们今日电话中的约定，我希望取得当年用于模拟原子弹演示的那份配方。',
            ),
            Block(
                'paragraph',
                'We are interested in the large atmospheric vortices which are produced as reported in the book "Scientific Study of Unidentified Flying Objects" by Dr. Edward U. Condon.',
                '我们关注的是该过程中产生的大型大气涡旋，相关情况在 Edward U. Condon 博士所著《不明飞行物科学研究》（Scientific Study of Unidentified Flying Objects）一书中有记载。',
            ),
            Block('signature', 'Yours sincerely,\nJames L. Tuck', '此致\n詹姆斯·L·塔克（James L. Tuck）'),
            Block('annotation', 'JLT:gsa', 'JLT:gsa（打字员缩写）'),
        ]
    else:
        blocks = [
            Block(
                'paragraph',
                '（本页为纯图像页，离线模式无示例内容）',
                '（本页为纯图像页，离线模式无示例内容）',
            )
        ]
    return PageResult(page=page_no, blocks=blocks, model='mock')
