import Head from 'next/head'
import styles from '../styles/Home.module.css'
import S3 from 'aws-sdk/clients/s3'
import React, { useEffect, useState } from 'react'
import { Analytics } from '@vercel/analytics/react'

type DayPrice = {
  date: string,
  hourPrices: {
    startTime: string,
    price: number
  }[]
}

type MonthData = {
  days: number
  totalKwh: number,
  totalCnt: number,
  maxKwh: { day: string, kwh: number, cnt: number } | undefined,
  maxCnt: { day: string, kwh: number, cnt: number } | undefined,
  minKwh: { day: string, kwh: number, cnt: number } | undefined,
  minCnt: { day: string, kwh: number, cnt: number } | undefined,
}

type ConsumptionData = { hour: string, kwh: number }[]

type HourPrice = { hour: string, price: number }

const finnishDate = (date: Date): string => date.toLocaleDateString('sv-SE', { timeZone: "Europe/Helsinki" })

const isFulfilled = <T,>(v: PromiseSettledResult<T>): v is PromiseFulfilledResult<T> => v.status === "fulfilled"

const datesFromStartOf2022 = (): string[] => {
  const currentDate = new Date()
  currentDate.setHours(0, 0, 0, 0)

  const firstDayOf2022 = new Date(2022, 0, 1)
  firstDayOf2022.setHours(0, 0, 0, 0)

  const numberOfDays = Math.floor((currentDate.valueOf() - firstDayOf2022.valueOf()) / 86400000)
  return Array(numberOfDays)
    .fill(0)
    .map((_, i) => new Date(firstDayOf2022).setDate(firstDayOf2022.getDate() + i))
    .map(d => new Date(d))
    .map(d => finnishDate(d))
}

const vatForHour = (hour: string): number => {
  if (hour >= "2022-11-30T22:00:00Z" && hour <= "2023-04-31T22:00:00Z") {
    return 1.10
  }
  else {
    return 1.24
  }
}

export async function getStaticProps() {
  const s3 = new S3({
    accessKeyId: process.env.TH_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.TH_AWS_SECRET_ACCESS_KEY,
    region: process.env.TH_AWS_REGION,
    apiVersion: '2006-03-01',
  })

  const dateStrings = datesFromStartOf2022()

  const requests = dateStrings.map(date =>
    s3.getObject({ Bucket: process.env.TH_AWS_BUCKET as string, Key: `${date}.json` }).promise()
  )

  const results = await Promise.allSettled(requests)

  const failed = results.filter(r => !isFulfilled(r))
  if (failed.length > 0) {
    console.error(failed)
    throw new Error("Failed to fetch data from S3")
  }

  const data: DayPrice[] = (await Promise.allSettled(requests))
    .filter(isFulfilled)
    .map(({ value }) => JSON.parse(value.Body?.toString() ?? '{hourPrices: []}'))

  const dataset = data.flatMap(
    ({ hourPrices }) => hourPrices
      .map(e => ({ hour: e.startTime, price: e.price * vatForHour(e.startTime) })))

  return {
    props: {
      dataset,
    }
  }
}


const parseLines = (text: string, setConsumptionData: (data: ConsumptionData) => void): void => {
  const rows = text.split(/\r?\n/)
  const headers = rows[0].split(';')

  const knownHeaders = ['Mittauspisteen tunnus',
    'Tuotteen tyyppi',
    'Resoluutio',
    'Yksikkötyyppi',
    'Alkuaika',
    'Määrä',
    'Laatu']

  if (headers.length !== knownHeaders.length || !headers.every((h, i) => h === knownHeaders[i])) {
    throw new Error(`Outoja sarakkeita: ${headers}`)
  }

  const data = rows.slice(1).map(row => {
    const [_, __, ___, ____, time, kwh, _____] = row.split(';')
    if (time && kwh) {
      return { hour: time, kwh: parseFloat(kwh.replace(',', '.')) }
    }
  }).filter(e => e !== undefined) as ConsumptionData

  setConsumptionData(data)
}

const parse = (file: File, setConsumptionData: (data: ConsumptionData) => void): void => {
  const reader = new FileReader()
  reader.onload = (e) => {
    const text = e.target?.result as string
    parseLines(text, setConsumptionData)
  }
  reader.readAsText(file)
}

function ConsumptionCSVUploader({ setConsumptionData }: { setConsumptionData: (data: ConsumptionData) => void }): JSX.Element {
  const [csvFile, setCsvFile] = useState<File | undefined>()

  return (
    <form>
      <label className={styles.formLabel}>
        <input className={styles.input}
          type='file'
          accept='.csv'
          id='csvFile'
          onChange={
            e => {
              const file = e.target.files?.item(0)
              if (file) {
                setCsvFile(file)
              }
            }
          }
        >
        </input>
        Valitse csv-tiedosto
      </label>
      <div className={styles.csvFile}>{csvFile?.name ?? "(ei valittu)"}</div>
      <button disabled={csvFile === undefined} className={styles.button}
        onClick={
          e => {
            e.preventDefault()
            if (csvFile) {
              parse(csvFile, setConsumptionData)
            }
          }
        }
      >
        Lue tiedosto
      </button>
    </form>
  )
}

const extractMonthFromHour = ({ hour }: { hour: string }): string => hour.slice(0, 7)

const getMonths = (consumptionData: ConsumptionData, dataset: HourPrice[]): string[] => {
  const consumptionMonths = new Set(consumptionData.map(extractMonthFromHour))
  const priceMonths = new Set(dataset.map(extractMonthFromHour))
  return Array.from(consumptionMonths).filter(e => priceMonths.has(e))
}

const consumptionDataForMonth = (month: string, consumptionData: ConsumptionData): ConsumptionData => {
  return consumptionData.filter(e => e.hour.startsWith(month))
}

const prettyPrintMonth = (month: string): string => {
  return new Date(month).toLocaleString('fi-FI', { month: 'long', year: 'numeric' })
}

const prettyPrintDay = (e: ({ day: string } | undefined)): string => {
  return e
    ? new Date(e.day).toLocaleString('fi-FI', { weekday: 'long', day: 'numeric' }) + " päivä"
    : ""
}

const prettyPrintEur = (e: ({ cnt: number } | undefined)): string => {
  return e ? (e.cnt / 100.0).toFixed(2) + " €" : ""
}

const prettyPrintCPerKwh = (e: ({ cnt: number, kwh: number } | undefined)): string => {
  return e ? (e.cnt / e.kwh).toFixed(2) + " c/kWh" : ""
}

const prettyPrintKwh = (e: ({ kwh: number } | undefined)): string => {
  return e ? e.kwh.toFixed(2) + " kWh" : ""
}

const aggregateByDay = (day: string, prices: HourPrice[], consumptionsForDay: ConsumptionData): { day: string, data: { kwh: number, cnt: number } } => {
  return {
    day,
    data: consumptionsForDay.reduce((acc, { hour, kwh }) => {
      const price = prices.find(e => e.hour === hour)?.price ?? 0
      acc.kwh += kwh
      acc.cnt += kwh * price
      return acc
    }, { kwh: 0, cnt: 0 })
  }
}


function Month({ month, prices, consumptionData, activeMonth, setActiveMonth }:
  {
    month: string,
    prices: HourPrice[],
    consumptionData: ConsumptionData,
    activeMonth: string | undefined,
    setActiveMonth: (month: string) => void
  }): JSX.Element {

  const [data, setData] = useState<MonthData | undefined>()


  const extractDayFromHour = ({ hour }: { hour: string }): string => hour.slice(0, 10)

  useEffect(() => {
    const days = Array.from(new Set(consumptionDataForMonth(month, consumptionData).map(extractDayFromHour)))
    const daysWithPriceData = new Set(prices.map(extractDayFromHour))

    const daysData = days.filter(day => daysWithPriceData.has(day)).map(day => {
      return aggregateByDay(day, prices, consumptionData.filter(e => e.hour.startsWith(day)))
    })

    setData(daysData.reduce((acc: MonthData, e) => {
      acc.totalKwh += e.data.kwh
      acc.totalCnt += e.data.cnt
      if (!acc.maxKwh || e.data.kwh > acc.maxKwh.kwh) {
        acc.maxKwh = { day: e.day, cnt: e.data.cnt, kwh: e.data.kwh }
      }
      if (!acc.maxCnt || e.data.cnt > acc.maxCnt.cnt) {
        acc.maxCnt = { day: e.day, cnt: e.data.cnt, kwh: e.data.kwh }
      }
      if (!acc.minKwh || e.data.kwh < acc.minKwh.kwh) {
        acc.minKwh = { day: e.day, cnt: e.data.cnt, kwh: e.data.kwh }
      }
      if (!acc.minCnt || e.data.cnt < acc.minCnt.cnt) {
        acc.minCnt = { day: e.day, cnt: e.data.cnt, kwh: e.data.kwh }
      }
      return acc
    }, { days: days.length, totalKwh: 0, totalCnt: 0, maxKwh: undefined, maxCnt: undefined, minKwh: undefined, minCnt: undefined } /*as MonthData*/))
  }, [month, prices, consumptionData])

  return (
    <div className={styles.card}
      onClick={e => setActiveMonth(month)}>
      <h2>{prettyPrintMonth(month)}</h2>
      {!data && <div>Lasketaan...</div>}
      {data && (
        <React.Fragment>
          <h3>{(data.totalCnt / data.totalKwh).toFixed(2)} c / kWh</h3>
          <h3>{(data.totalKwh / data.days).toFixed(2)} kWh / vrk</h3>
          <h3>{data.totalKwh.toFixed(0)} kWh</h3>
          <h3>{(data.totalCnt / 100.0).toFixed(2)} €</h3>
          {activeMonth === month && (
            <React.Fragment>
              <h3>Halvin päivä</h3>
              <div>{prettyPrintDay(data.minCnt)}: {prettyPrintEur(data.minCnt)}, {prettyPrintCPerKwh(data.minCnt)}</div>
              <h3>Kallein päivä</h3>
              <div> {prettyPrintDay(data.maxCnt)}: {prettyPrintEur(data.maxCnt)}, {prettyPrintCPerKwh(data.maxCnt)}</div>
              <h3>Pienin kulutus</h3>
              <div>{prettyPrintDay(data.minKwh)}: {prettyPrintKwh(data.minKwh)}</div>
              <h3>Suurin kulutus</h3>
              <div>{prettyPrintDay(data.maxKwh)}: {prettyPrintKwh(data.maxKwh)}</div>
            </React.Fragment>
          )}
        </React.Fragment>
      )}
    </div>
  )
}

function MonthlyPrices({ dataset, consumptionData }: { dataset: HourPrice[], consumptionData: ConsumptionData }) {
  const [activeMonth, setActiveMonth] = useState<string | undefined>()
  const [months, setMonths] = useState<string[]>([])

  useEffect(() => {
    const m = getMonths(consumptionData, dataset).reverse()
    setMonths(m)
  }, [dataset, consumptionData])

  useEffect(() => {
    if (activeMonth === undefined && months.length > 0) {
      setActiveMonth(months[0])
    }
  }, [activeMonth, months])

  return (
    <div className={styles.grid}>
      {months.map(month => {
        return <Month activeMonth={activeMonth} setActiveMonth={setActiveMonth} key={month} month={month} prices={dataset} consumptionData={consumptionData} />
      })}
    </div>
  )
}

export default function Home({ dataset }: { dataset: HourPrice[] }) {

  const [consumptionData, setConsumptionData] = useState<ConsumptionData>()
  return (
    <div className={styles.container}>
      <Head>
        <title>tuntihintavertailu</title>
      </Head>

      <main className={styles.main}>
        <h1 className={styles.title}>
          tunti&shy;hinta&shy;vertailu
        </h1>
        <p className={styles.description}>
          Lataa ensin kulutustietosi csv-muodossa <a className={styles.link} href='https://oma.datahub.fi/'>Fingridin datahubista</a>.
          Valitse sitten ladattu tiedosto alla olevalla painikkeella, paina <i>&quot;Lue tiedosto&quot;</i> ja odota hetki. Kulutustietojasi ei lähetetä mihinkään, vaan ne käsitellään paikallisesti selaimessasi.</p>
        <p className={styles.description}>Hinnat ovat arvonlisäverollisia hintoja (10% tai 24%). Hinnoissa ei ole mukana sähköyhtiön marginaalia (tyypillisesti n. 0.40 c / kWh) eikä siirtomaksuja.</p>
        <p className={styles.description}>
          Ohjeet datahubiin:</p> <ul className={styles.description}>
          <li>Valitse ensin käyttöpaikka</li>
          <li>Valitse <i>&quot;Energiaraportointi&quot;</i> ja <i>&quot;Lataa tiedot&quot;</i></li>
          <li>Syötä alkamis- ja päättymispäivämäärät</li>
          <li>Valitse jälleen käyttöpaikka</li>
          <li>Paina <i>&quot;Lataa&quot;</i></li>
        </ul>
        <ConsumptionCSVUploader setConsumptionData={setConsumptionData} />
        {(consumptionData || []).length > 0 && <MonthlyPrices dataset={dataset} consumptionData={consumptionData ?? []} />}
      </main>
      <Analytics />
    </div>
  )
}
