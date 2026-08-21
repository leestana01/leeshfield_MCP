// Jenkinsfile for leeshfield-mcp (Node) — develop→dev / main→prod
pipeline {
    agent none

    environment {
        OCIR_REGISTRY = 'yny.ocir.io'
        OCIR_NAMESPACE = 'axlgn2n9ijoa'
        IMAGE_NAME = 'leeshfield-mcp/app'
        GITOPS_REPO = 'https://github.com/leestana01/gitops.git'
        GITOPS_CREDENTIALS = 'github-credentials'
    }

    stages {
        stage('Determine Environment') {
            // pipeline-level `agent none` 환경에서는 경량 파드로 env 결정만 수행
            agent {
                kubernetes {
                    label 'leeshfield-mcp-resolve'
                    yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: shell
      image: docker.io/alpine:3.20
      command: ['cat']
      tty: true
      resources:
        requests:
          cpu: '50m'
          memory: '64Mi'
        limits:
          cpu: '200m'
          memory: '128Mi'
"""
                }
            }
            steps {
                script {
                    if (env.BRANCH_NAME == 'main') {
                        env.TARGET_ENV = 'prod'
                        env.GITOPS_KUSTOMIZE_DIR = 'apps/leeshfield-mcp/overlays/prod'
                    } else if (env.BRANCH_NAME == 'develop') {
                        env.TARGET_ENV = 'dev'
                        env.GITOPS_KUSTOMIZE_DIR = 'apps/leeshfield-mcp/overlays/dev'
                    } else {
                        error "Branch ${env.BRANCH_NAME} is not configured for deployment"
                    }
                    env.IMAGE_TAG = "${env.TARGET_ENV}-${env.BUILD_NUMBER}"
                    env.FULL_IMAGE = "${OCIR_REGISTRY}/${OCIR_NAMESPACE}/${IMAGE_NAME}:${env.IMAGE_TAG}"
                }
            }
        }

        stage('Build & Push Docker Image') {
            // tools(bitnami/kubectl) + kaniko 컨테이너 조합 — sh 는 tools 에서 실행되어
            // durable-task 종료 감지가 정상 동작하고 kaniko 는 kubectl exec 로 명령을 받는다.
            //
            // resources 는 필수다. 노드 allocatable 이 CPU 840m / MEM ~6.3Gi 인 작은 ARM
            // 노드라, 제한 없는 kaniko(Next.js 빌드)가 메모리를 전부 먹으면 커널 OOM 으로
            // kubelet 까지 죽어 노드가 NotReady 로 빠진다. 실제로 develop·main 빌드가 동시에
            // 뜬 날 노드 하나가 이 경로로 사망했다. requests 는 작은 노드에도 스케줄되도록
            // 낮게, limits 는 노드를 지키도록 건다.
            agent {
                kubernetes {
                    label 'leeshfield-mcp-kaniko'
                    yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: tools
      image: docker.io/bitnami/kubectl:latest
      command: ['cat']
      tty: true
      securityContext:
        runAsUser: 0
      resources:
        requests:
          cpu: '50m'
          memory: '64Mi'
        limits:
          cpu: '200m'
          memory: '256Mi'
    - name: kaniko
      image: gcr.io/kaniko-project/executor:debug
      command: ['/busybox/cat']
      tty: true
      resources:
        requests:
          cpu: '200m'
          memory: '1Gi'
        limits:
          cpu: '700m'
          memory: '3Gi'
      volumeMounts:
        - name: docker-config
          mountPath: /kaniko/.docker
  volumes:
    - name: docker-config
      secret:
        secretName: ocir-kaniko-secret
"""
                }
            }
            steps {
                // env 별 kaniko cache repo 분리 — dev/prod 캐시 상호 오염 방지
                script {
                    env.KANIKO_CACHE_REPO = "${OCIR_REGISTRY}/${OCIR_NAMESPACE}/${IMAGE_NAME}/cache/${env.TARGET_ENV}"
                }
                container('tools') {
                    sh """
                        kubectl exec -n jenkins \$(hostname) -c kaniko -- /kaniko/executor \\
                            --context=dir://\${WORKSPACE} \\
                            --dockerfile=\${WORKSPACE}/Dockerfile \\
                            --customPlatform=linux/arm64 \\
                            --destination=${env.FULL_IMAGE} \\
                            --destination=${OCIR_REGISTRY}/${OCIR_NAMESPACE}/${IMAGE_NAME}:${env.TARGET_ENV} \\
                            --cache=true \\
                            --cache-repo=${env.KANIKO_CACHE_REPO} \\
                            --cache-ttl=168h
                    """
                }
            }
        }

        stage('Update GitOps Repository') {
            agent {
                kubernetes {
                    label 'leeshfield-mcp-gitops'
                    yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: git
      image: docker.io/alpine/git:latest
      command: ['cat']
      tty: true
      resources:
        requests:
          cpu: '50m'
          memory: '64Mi'
        limits:
          cpu: '200m'
          memory: '256Mi'
"""
                }
            }
            steps {
                container('git') {
                    withCredentials([usernamePassword(credentialsId: "${GITOPS_CREDENTIALS}", usernameVariable: 'GIT_USER', passwordVariable: 'GIT_TOKEN')]) {
                        // 토큰은 http.extraheader base64 로만 전달 — 어디에도 평문 노출 금지.
                        // NFS 워크스페이스에 이전 빌드 잔여물이 있을 수 있어 clone 전 삭제.
                        sh '''
                            set +x
                            rm -rf gitops-repo
                            GIT_AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$GIT_USER" "$GIT_TOKEN" | base64 | tr -d '\\n')"
                            git -c http.extraheader="$GIT_AUTH_HEADER" \\
                                clone https://github.com/leestana01/gitops.git gitops-repo
                        '''
                        sh """
                            set +x
                            GIT_AUTH_HEADER="Authorization: Basic \$(printf '%s:%s' "\$GIT_USER" "\$GIT_TOKEN" | base64 | tr -d '\\n')"
                            cd gitops-repo
                            sed -i "s|newTag:.*|newTag: ${env.IMAGE_TAG}|" ${env.GITOPS_KUSTOMIZE_DIR}/kustomization.yaml

                            git config user.email "jenkins@klr.kr"
                            git config user.name "Jenkins CI"
                            git add ${env.GITOPS_KUSTOMIZE_DIR}/kustomization.yaml
                            git commit -m "update ${IMAGE_NAME} to ${env.IMAGE_TAG}" || echo "No changes to commit"
                            git -c http.extraheader="\$GIT_AUTH_HEADER" push origin HEAD:main
                        """
                    }
                }
            }
        }
    }

    post {
        success {
            script {
                notifyDiscord('success')
            }
        }
        failure {
            script {
                notifyDiscord('failure')
            }
        }
        aborted {
            script {
                notifyDiscord('aborted')
            }
        }
    }
}

// Discord 알림 헬퍼 — agent none 이라 post 에서 경량 파드를 띄워 webhook 만 전송.
// 알림 실패가 파이프라인 결과를 바꾸지 않도록 try/catch.
def notifyDiscord(String status) {
    def color
    def emoji
    def text
    switch (status) {
        case 'success': color = 3066993;  emoji = ':white_check_mark:'; text = 'Success'; break
        case 'failure': color = 15158332; emoji = ':x:';                text = 'Failure'; break
        case 'aborted': color = 15105570; emoji = ':warning:';          text = 'Aborted'; break
        default:        color = 9807270;  emoji = ':information_source:'; text = status
    }
    def jobName   = (env.JOB_NAME   ?: '').toString()
    def buildNum  = (env.BUILD_NUMBER ?: '').toString()
    def branch    = (env.BRANCH_NAME ?: '-').toString()
    def buildUrl  = (env.BUILD_URL  ?: '').toString()
    def targetEnv = (env.TARGET_ENV ?: '-').toString()
    def imageTag  = (env.IMAGE_TAG  ?: '-').toString()
    def duration  = (currentBuild.durationString ?: '-').replace(' and counting', '')

    def podLabel = "leeshfield-mcp-discord-${env.BUILD_NUMBER}"
    // bitnami/kubectl(Debian, curl 포함) — Alpine sh 는 durable-task 와 충돌해 hang 위험
    try {
        podTemplate(
            label: podLabel,
            yaml: '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: shell
      image: docker.io/bitnami/kubectl:latest
      command: ['cat']
      tty: true
      securityContext:
        runAsUser: 0
      resources:
        requests:
          cpu: '50m'
          memory: '64Mi'
        limits:
          cpu: '200m'
          memory: '128Mi'
'''
        ) {
            node(podLabel) {
                container('shell') {
                    def payload = groovy.json.JsonOutput.toJson([
                        username: 'Jenkins',
                        avatar_url: 'https://www.jenkins.io/images/logos/jenkins/jenkins.png',
                        embeds: [[
                            title: "${emoji} ${jobName} #${buildNum}".toString(),
                            url: buildUrl,
                            color: color,
                            fields: [
                                [name: 'Status',   value: text,      inline: true],
                                [name: 'Branch',   value: branch,    inline: true],
                                [name: 'Env',      value: targetEnv, inline: true],
                                [name: 'Image',    value: imageTag,  inline: true],
                                [name: 'Duration', value: duration,  inline: true]
                            ]
                        ]]
                    ])
                    writeFile file: 'discord-payload.json', text: payload
                    withCredentials([string(credentialsId: 'Discord-Webhook', variable: 'DISCORD_WEBHOOK_URL')]) {
                        sh '''
                            set +x
                            curl -sS --max-time 15 --retry 2 --retry-delay 2 \
                                -o /dev/null -w "discord webhook HTTP %{http_code}\\n" \
                                -H "Content-Type: application/json" \
                                -X POST --data-binary @discord-payload.json \
                                "$DISCORD_WEBHOOK_URL"
                        '''
                    }
                }
            }
        }
    } catch (err) {
        echo "Discord notification failed: ${err.message}"
    }
}
