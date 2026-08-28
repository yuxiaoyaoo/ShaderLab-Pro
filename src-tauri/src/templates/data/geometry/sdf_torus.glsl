mat2 rot(float a)
{
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
}

float map(vec3 p)
{
    vec3 q = p;
    q.xz = rot(iTime * 0.5) * q.xz;
    vec2 w = vec2(length(q.xz) - 1.0, q.y);
    return length(w) - 0.35;
}

vec3 calcNormal(vec3 p)
{
    vec2 e = vec2(0.0015, 0.0);
    return normalize(vec3(
        map(p + e.xyy) - map(p - e.xyy),
        map(p + e.yxy) - map(p - e.yxy),
        map(p + e.yyx) - map(p - e.yyx)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 ro = vec3(0.0, 0.9, -3.4);
    vec3 rd = normalize(vec3(uv, -1.8));
    ro.yz = rot(-0.18) * ro.yz;
    rd.yz = rot(-0.18) * rd.yz;

    float t = 0.0;
    float tMax = 20.0;
    bool hit = false;
    for (int i = 0; i < 90; i++)
    {
        vec3 p = ro + rd * t;
        float d = map(p);
        if (d < 0.0012 * t + 0.0006)
        {
            hit = true;
            break;
        }
        t += d * 0.92;
        if (t > tMax)
        {
            break;
        }
    }

    vec3 sky = mix(vec3(0.12, 0.10, 0.16), vec3(0.05, 0.05, 0.09), clamp(rd.y * 0.5 + 0.5, 0.0, 1.0));
    vec3 col = sky;

    if (hit)
    {
        vec3 p = ro + rd * t;
        vec3 n = calcNormal(p);
        vec3 lightDir = normalize(vec3(0.7, 0.9, 0.5));
        float diff = max(dot(n, lightDir), 0.0);
        float spec = pow(max(dot(reflect(-lightDir, n), -rd), 0.0), 48.0);
        float fres = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);

        vec3 base = mix(vec3(0.35, 0.55, 0.85), vec3(0.95, 0.45, 0.30), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
        col = base * (0.08 + 0.9 * diff) + vec3(spec) * 0.9 + base * fres * 0.4;
        col = mix(col, sky, 1.0 - exp(-0.002 * t * t));
    }

    fragColor = vec4(col, 1.0);
}
