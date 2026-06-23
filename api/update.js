// Vercel Serverless Function - Node.js 환경 전용 기밀 동기화 처리기
// UTF-8 한국어 우회를 안전하게 지원하기 위해 Buffer API 활용 및 의존성 최소화

export default async function handler(req, res) {
    // CORS 헤더 설정 (클라이언트 도메인과의 안정적인 통신을 보장)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // OPTIONS 사전 점검 요청 핸들링
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ message: "Method Not Allowed" });
    }

    const { commitMessage, members, secretKey } = req.body;

    // 1. 서버리스 요청 보안 키 인가 검증
    if (!secretKey || secretKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ message: "Forbidden: Invalid Secret Key" });
    }

    if (!members || !Array.isArray(members)) {
        return res.status(400).json({ message: "Bad Request: Invalid Members Payload" });
    }

    // 2. Vercel 환경 변수 격리 검출
    const pat = process.env.GITHUB_PAT;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!pat || !owner || !repo) {
        return res.status(500).json({ message: "Internal Configuration Error: Vercel 환경 변수가 누락되었습니다." });
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/index.html`;

    try {
        // 3. GitHub API를 통해 최신 index.html 본체 다운로드
        const getRes = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${pat}`,
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Vercel-Serverless-Function"
            }
        });

        if (!getRes.ok) {
            const errRes = await getRes.json().catch(() => ({}));
            throw new Error(`GitHub File Fetch Failed: ${errRes.message || getRes.status}`);
        }

        const getData = await getRes.json();
        const sha = getData.sha;
        
        // base64로 넘어온 원본 소스코드를 안전하게 문자열로 복호화 (멀티바이트 한글 깨짐 방지)
        const rawContent = Buffer.from(getData.content, 'base64').toString('utf-8');

        // 4. 주석 정규식 앵커에 데이터를 인젝션 및 치환 가공
        const regex = /(\/\* GITHUB_DATA_START \*\/)[\s\S]*?(\/\* GITHUB_DATA_END \*\/)/;
        const newBlock = `/* GITHUB_DATA_START */\n        const defaultMembers = ${JSON.stringify(members, null, 12)};\n        /* GITHUB_DATA_END */`;

        if (!regex.test(rawContent)) {
            throw new Error("index.html 내부에서 GITHUB_DATA 주석 앵커를 식별할 수 없습니다.");
        }

        const updatedContent = rawContent.replace(regex, newBlock);
        const encodedContent = Buffer.from(updatedContent, 'utf-8').toString('base64');

        // 5. GitHub API를 통해 새로운 소스코드 커밋 & 푸시
        const putRes = await fetch(url, {
            method: 'PUT',
            headers: {
                "Authorization": `Bearer ${pat}`,
                "Content-Type": "application/json",
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "Vercel-Serverless-Function"
            },
            body: JSON.stringify({
                message: commitMessage || "Tactical Update: Serverless Auto Sync",
                content: encodedContent,
                sha: sha,
                branch: branch
            })
        });

        if (!putRes.ok) {
            const errRes = await putRes.json().catch(() => ({}));
            throw new Error(`GitHub Commit Failed: ${errRes.message || putRes.status}`);
        }

        return res.status(200).json({ success: true, message: "Serverless synchronization completed successfully." });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
}
